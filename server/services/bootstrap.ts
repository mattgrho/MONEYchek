import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accountingSettings,
  brandSettings,
  companyProfiles,
  deploymentSettings,
  memberships,
  organizations,
  purchasingSettings,
  roles,
  salesSettings,
} from '../db/schema/index';
import { ROLE_PRESETS } from '@shared/permissions';
import type { AuthenticatedIdentity } from '../auth/adapter';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';
import { writeAuditEvent } from '../accounting/audit';
import { syncUser } from './identity';

const BOOTSTRAP_LOCK_KEY = 727_002_001;

export interface BootstrapStatus {
  bootstrapped: boolean;
  ownerEmailConfigured: boolean;
}

export async function getBootstrapStatus(db: Db): Promise<BootstrapStatus> {
  const rows = await db.select().from(deploymentSettings).limit(1);
  return {
    bootstrapped: Boolean(rows[0]?.primaryOrganizationId),
    ownerEmailConfigured: Boolean(getEnv().BOOTSTRAP_OWNER_EMAIL),
  };
}

/**
 * Secure owner bootstrap. Atomic and race-free:
 *  - global advisory lock; re-check inside the transaction
 *  - the caller's VERIFIED email must equal BOOTSTRAP_OWNER_EMAIL
 *  - creates organization, seeds preset roles, owner membership, settings
 *    shells, and the single deployment_settings row
 *  - once completed the path is permanently disabled (409 afterwards)
 */
export async function performBootstrap(
  db: Db,
  input: { identity: AuthenticatedIdentity; companyName: string; correlationId: string },
): Promise<{ organizationId: string }> {
  const env = getEnv();
  const authorized = env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase();
  if (!authorized) {
    throw AppError.serviceUnavailable(
      'BOOTSTRAP_NOT_CONFIGURED',
      'BOOTSTRAP_OWNER_EMAIL is not configured for this deployment',
    );
  }
  if (!input.identity.emailVerified || input.identity.email.toLowerCase() !== authorized) {
    throw AppError.forbidden('This account is not authorized to claim the deployment');
  }
  const companyName = input.companyName.trim();
  if (companyName.length < 1 || companyName.length > 200) {
    throw AppError.validation('Company name is required', { companyName: ['1-200 characters'] });
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);
    const existing = await tx.select().from(deploymentSettings).limit(1);
    if (existing[0]?.primaryOrganizationId) {
      throw AppError.conflict('ALREADY_BOOTSTRAPPED', 'This deployment already has an owner');
    }

    const user = await syncUser(tx, input.identity);

    const [org] = await tx.insert(organizations).values({ name: companyName }).returning();
    if (!org) throw AppError.internal();

    let ownerRoleId: string | null = null;
    for (const [key, preset] of Object.entries(ROLE_PRESETS)) {
      const [role] = await tx
        .insert(roles)
        .values({
          organizationId: org.id,
          key,
          name: preset.name,
          description: preset.description,
          permissions: preset.permissions,
          isSystem: true,
        })
        .returning();
      if (key === 'owner') ownerRoleId = role!.id;
    }
    if (!ownerRoleId) throw AppError.internal();

    await tx.insert(memberships).values({
      organizationId: org.id,
      userId: user.id,
      roleId: ownerRoleId,
    });

    await tx.insert(companyProfiles).values({
      organizationId: org.id,
      legalName: companyName,
      displayName: companyName,
    });
    await tx.insert(brandSettings).values({ organizationId: org.id });
    await tx.insert(accountingSettings).values({ organizationId: org.id });
    await tx.insert(salesSettings).values({ organizationId: org.id });
    await tx.insert(purchasingSettings).values({ organizationId: org.id });

    await tx
      .insert(deploymentSettings)
      .values({
        id: 1,
        primaryOrganizationId: org.id,
        bootstrapCompletedAt: new Date(),
        bootstrapOwnerEmail: input.identity.email,
      })
      .onConflictDoUpdate({
        target: deploymentSettings.id,
        set: {
          primaryOrganizationId: org.id,
          bootstrapCompletedAt: new Date(),
          bootstrapOwnerEmail: input.identity.email,
          updatedAt: new Date(),
        },
      });

    await writeAuditEvent(tx, {
      organizationId: org.id,
      actorUserId: user.id,
      actorRole: 'owner',
      action: 'bootstrap.completed',
      entityType: 'organization',
      entityId: org.id,
      payload: { companyName, ownerEmail: input.identity.email },
      correlationId: input.correlationId,
    });

    return { organizationId: org.id };
  });
}
