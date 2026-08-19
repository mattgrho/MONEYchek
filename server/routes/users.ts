import { Router } from 'express';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { invitations, memberships, roles, users } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { orgCtx, requirePermission } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { asyncHandler, parseBody, parseParams } from '../middleware/validate';
import { createInvitation, revokeInvitation } from '../services/invitations';
import { writeAuditEvent } from '../accounting/audit';

export const usersRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });

usersRouter.get(
  '/roles',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select({
        id: roles.id,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .where(eq(roles.organizationId, ctx.organizationId))
      .orderBy(roles.name);
    res.json({ items: rows });
  }),
);

usersRouter.get(
  '/members',
  requirePermission('users.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select({
        membershipId: memberships.id,
        status: memberships.status,
        userId: users.id,
        email: users.email,
        name: users.name,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        createdAt: memberships.createdAt,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(memberships.roleId, roles.id))
      .where(eq(memberships.organizationId, ctx.organizationId))
      .orderBy(users.email);
    res.json({ items: rows });
  }),
);

const UpdateMemberSchema = z.object({
  roleId: z.string().uuid().optional(),
  status: z.enum(['active', 'removed']).optional(),
});

usersRouter.patch(
  '/members/:id',
  requirePermission('users.administer'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, UpdateMemberSchema);
    const db = getDb();
    await db.transaction(async (tx) => {
      const [membership] = await tx
        .select()
        .from(memberships)
        .where(and(eq(memberships.id, id), eq(memberships.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!membership) throw AppError.notFound('Member not found');

      if (body.roleId) {
        const [role] = await tx
          .select()
          .from(roles)
          .where(and(eq(roles.id, body.roleId), eq(roles.organizationId, ctx.organizationId)))
          .limit(1);
        if (!role) throw AppError.validation('Unknown role', { roleId: ['Select a valid role'] });
      }

      // Never allow removing/demoting the last active owner.
      const [ownerRole] = await tx
        .select()
        .from(roles)
        .where(and(eq(roles.organizationId, ctx.organizationId), eq(roles.key, 'owner')))
        .limit(1);
      if (ownerRole && membership.roleId === ownerRole.id) {
        const demoting = body.roleId && body.roleId !== ownerRole.id;
        const removing = body.status === 'removed';
        if (demoting || removing) {
          const owners = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.organizationId, ctx.organizationId),
                eq(memberships.roleId, ownerRole.id),
                eq(memberships.status, 'active'),
              ),
            );
          if (owners.length <= 1) {
            throw AppError.conflict('LAST_OWNER', 'The company must keep at least one owner');
          }
        }
      }

      await tx
        .update(memberships)
        .set({
          ...(body.roleId ? { roleId: body.roleId } : {}),
          ...(body.status ? { status: body.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(memberships.id, id));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: body.status === 'removed' ? 'member.removed' : 'member.updated',
        entityType: 'membership',
        entityId: id,
        payload: { roleId: body.roleId, status: body.status },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true });
  }),
);

usersRouter.get(
  '/invitations',
  requirePermission('users.invite'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select({
        id: invitations.id,
        email: invitations.email,
        roleId: invitations.roleId,
        expiresAt: invitations.expiresAt,
        acceptedAt: invitations.acceptedAt,
        revokedAt: invitations.revokedAt,
        createdAt: invitations.createdAt,
      })
      .from(invitations)
      .where(eq(invitations.organizationId, ctx.organizationId))
      .orderBy(desc(invitations.createdAt))
      .limit(200);
    res.json({ items: rows });
  }),
);

const CreateInvitationSchema = z.object({ email: z.string().email(), roleId: z.string().uuid() });

usersRouter.post(
  '/invitations',
  requirePermission('users.invite'),
  rateLimit({ name: 'invitation-create', limit: 20, windowSeconds: 3600 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CreateInvitationSchema);
    const result = await createInvitation(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

usersRouter.delete(
  '/invitations/:id',
  requirePermission('users.invite'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    await revokeInvitation(getDb(), ctx, id, req.correlationId);
    res.json({ ok: true });
  }),
);
