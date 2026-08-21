import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import { invitations, memberships, roles } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { getEnv } from '../config/env';
import { writeAuditEvent } from '../accounting/audit';
import { enqueueOutboxEvent } from './outbox';
import type { OrgContext } from './identity';
import type { AuthenticatedIdentity } from '../auth/adapter';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a high-entropy, single-use, expiring invitation. The token is
 * returned exactly once (for manual delivery); only its hash is stored.
 */
export async function createInvitation(
  db: Db,
  ctx: OrgContext,
  input: { email: string; roleId: string },
  correlationId: string,
): Promise<{ id: string; inviteUrl: string; expiresAt: string }> {
  const email = input.email.trim().toLowerCase();
  const role = await db
    .select()
    .from(roles)
    .where(and(eq(roles.id, input.roleId), eq(roles.organizationId, ctx.organizationId)))
    .limit(1);
  if (!role[0]) throw AppError.validation('Unknown role', { roleId: ['Select a valid role'] });

  const token = randomBytes(32).toString('hex'); // 256 bits of entropy
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(invitations)
      .values({
        organizationId: ctx.organizationId,
        email,
        roleId: input.roleId,
        tokenHash: hashToken(token),
        invitedByUserId: ctx.userId,
        expiresAt,
      })
      .returning();
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'invitation.created',
      entityType: 'invitation',
      entityId: row!.id,
      payload: { email, roleKey: role[0]!.key },
      correlationId,
    });
    // Queue the invitation email in the same transaction. Delivery only
    // happens when the job runner drains the outbox with a configured
    // provider; until then the inviter shares the link manually. The queued
    // body carries the live link (unlike invitations, which store only the
    // token hash): acceptance is still bound to the invited email's verified
    // identity, and the worker scrubs the body once delivered.
    const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
    await enqueueOutboxEvent(tx, {
      organizationId: ctx.organizationId,
      jobType: 'email.invitation',
      idempotencyKey: `invitation-${row!.id}`,
      payload: {
        to: email,
        subject: `You are invited to join as ${role[0]!.name}`,
        text: [
          `You have been invited to join the company books as ${role[0]!.name}.`,
          '',
          `Accept the invitation here: ${base}/accept-invitation?token=${token}`,
          '',
          `This link is single-use and expires ${expiresAt.toISOString().slice(0, 10)}.`,
          'If you were not expecting this invitation, ignore this message.',
        ].join('\n'),
      },
    });
    return row!;
  });

  const base = getEnv().APP_BASE_URL.replace(/\/$/, '');
  return {
    id: created.id,
    inviteUrl: `${base}/accept-invitation?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function revokeInvitation(
  db: Db,
  ctx: OrgContext,
  invitationId: string,
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(invitations)
      .where(
        and(eq(invitations.id, invitationId), eq(invitations.organizationId, ctx.organizationId)),
      )
      .limit(1);
    if (!row) throw AppError.notFound('Invitation not found');
    if (row.acceptedAt)
      throw AppError.conflict('ALREADY_ACCEPTED', 'Invitation was already accepted');
    await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(eq(invitations.id, invitationId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'invitation.revoked',
      entityType: 'invitation',
      entityId: invitationId,
      correlationId,
    });
  });
}

/**
 * Accepts an invitation for the authenticated identity. The verified email
 * must match the invitation email; the token is single-use.
 */
export async function acceptInvitation(
  db: Db,
  input: { identity: AuthenticatedIdentity; userId: string; token: string; correlationId: string },
): Promise<{ organizationId: string }> {
  return db.transaction((tx) => acceptInvitationInTx(tx, input));
}

/** In-transaction variant (also used by local-auth registration). */
export async function acceptInvitationInTx(
  tx: Tx,
  input: {
    identity: Pick<AuthenticatedIdentity, 'email'>;
    userId: string;
    token: string;
    correlationId: string;
  },
): Promise<{ organizationId: string }> {
  const tokenHash = hashToken(input.token);
  {
    const [invitation] = await tx
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, tokenHash))
      .for('update')
      .limit(1);
    if (!invitation) throw AppError.notFound('Invitation is invalid');
    if (invitation.revokedAt)
      throw AppError.conflict('INVITATION_REVOKED', 'Invitation was revoked');
    if (invitation.acceptedAt)
      throw AppError.conflict('ALREADY_ACCEPTED', 'Invitation was already used');
    if (invitation.expiresAt.getTime() < Date.now())
      throw AppError.conflict('INVITATION_EXPIRED', 'Invitation has expired');
    if (invitation.email.toLowerCase() !== input.identity.email.toLowerCase()) {
      throw AppError.forbidden('This invitation was issued to a different email address');
    }

    const existing = await tx
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, invitation.organizationId),
          eq(memberships.userId, input.userId),
        ),
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].status === 'active') {
        throw AppError.conflict('ALREADY_MEMBER', 'You are already a member');
      }
      await tx
        .update(memberships)
        .set({ status: 'active', roleId: invitation.roleId, updatedAt: new Date() })
        .where(eq(memberships.id, existing[0].id));
    } else {
      await tx.insert(memberships).values({
        organizationId: invitation.organizationId,
        userId: input.userId,
        roleId: invitation.roleId,
      });
    }
    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedByUserId: input.userId })
      .where(eq(invitations.id, invitation.id));
    await writeAuditEvent(tx, {
      organizationId: invitation.organizationId,
      actorUserId: input.userId,
      action: 'invitation.accepted',
      entityType: 'invitation',
      entityId: invitation.id,
      payload: { email: invitation.email },
      correlationId: input.correlationId,
    });
    return { organizationId: invitation.organizationId };
  }
}
