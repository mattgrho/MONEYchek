import { eq } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { deploymentSettings, memberships, roles, users } from '../db/schema/index';
import type { AuthenticatedIdentity } from '../auth/adapter';
import { getEnv } from '../config/env';
import { AppError } from '../lib/errors';

export interface OrgContext {
  organizationId: string;
  userId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
}

/** Upserts the local user row for a verified provider identity. */
export async function syncUser(
  db: DbOrTx,
  identity: AuthenticatedIdentity,
): Promise<typeof users.$inferSelect> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.authProviderId, identity.authProviderId))
    .limit(1);
  if (existing[0]) {
    const u = existing[0];
    if (u.email !== identity.email || u.name !== (identity.name ?? u.name)) {
      const updated = await db
        .update(users)
        .set({
          email: identity.email,
          name: identity.name ?? u.name,
          imageUrl: identity.imageUrl ?? u.imageUrl,
          updatedAt: new Date(),
        })
        .where(eq(users.id, u.id))
        .returning();
      return updated[0]!;
    }
    return u;
  }
  const inserted = await db
    .insert(users)
    .values({
      authProviderId: identity.authProviderId,
      email: identity.email,
      name: identity.name ?? null,
      imageUrl: identity.imageUrl ?? null,
    })
    .onConflictDoUpdate({
      target: users.authProviderId,
      set: { email: identity.email, updatedAt: new Date() },
    })
    .returning();
  return inserted[0]!;
}

/** The single-company deployment's primary organization id, or null pre-bootstrap. */
export async function getPrimaryOrganizationId(db: DbOrTx): Promise<string | null> {
  const rows = await db.select().from(deploymentSettings).limit(1);
  const primary = rows[0]?.primaryOrganizationId ?? null;
  const pinned = getEnv().PRIMARY_ORGANIZATION_ID;
  if (primary && pinned && pinned !== primary) {
    // Environment/database disagreement is a deployment fault: fail closed.
    throw AppError.serviceUnavailable(
      'DEPLOYMENT_MISCONFIGURED',
      'PRIMARY_ORGANIZATION_ID does not match the bootstrapped organization',
    );
  }
  return primary;
}

/**
 * Resolves the caller's organization context for the primary organization.
 * Returns null when the deployment is not bootstrapped or the user is not an
 * active member. Never trusts a client-supplied organization id.
 */
export async function resolveOrgContext(db: Db, userId: string): Promise<OrgContext | null> {
  const organizationId = await getPrimaryOrganizationId(db);
  if (!organizationId) return null;
  const rows = await db
    .select({
      membershipId: memberships.id,
      status: memberships.status,
      roleId: roles.id,
      roleKey: roles.key,
      roleName: roles.name,
      permissions: roles.permissions,
      orgId: memberships.organizationId,
    })
    .from(memberships)
    .innerJoin(roles, eq(memberships.roleId, roles.id))
    .where(eq(memberships.userId, userId));
  const active = rows.find((r) => r.orgId === organizationId && r.status === 'active');
  if (!active) return null;
  return {
    organizationId,
    userId,
    membershipId: active.membershipId,
    roleId: active.roleId,
    roleKey: active.roleKey,
    roleName: active.roleName,
    permissions: active.permissions,
  };
}
