import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb, type Tx } from '../db/client';
import { userCredentials, users } from '../db/schema/index';
import { getAuthAdapter } from '../auth/index';
import {
  createSession,
  readSessionToken,
  revokeOtherSessions,
  revokeSession,
  setSessionCookie,
  clearSessionCookie,
} from '../auth/local-adapter';
import { hashPassword, validatePasswordPolicy, verifyPassword } from '../auth/passwords';
import { asyncHandler, parseBody } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { getEnv } from '../config/env';
import { getBootstrapStatus } from '../services/bootstrap';
import { acceptInvitationInTx } from '../services/invitations';
import { writeAuditEvent } from '../accounting/audit';

/**
 * First-party auth endpoints, active only when AUTH_PROVIDER=local.
 * Registration is closed: the bootstrap owner email (pre-bootstrap) and
 * live invitation tokens are the only doors in. Every endpoint is
 * rate-limited against online guessing, and responses never reveal whether
 * an email exists.
 */

export const localAuthRouter = Router();

const EmailSchema = z.string().email().max(320);
const PasswordSchema = z.string().min(1).max(200);
const loginLimit = rateLimit({ name: 'auth_login', limit: 10, windowSeconds: 300 });
const registerLimit = rateLimit({ name: 'auth_register', limit: 10, windowSeconds: 300 });

async function requireLocalMode(): Promise<void> {
  const adapter = await getAuthAdapter();
  if (adapter.mode !== 'local') {
    throw AppError.notFound('Not found');
  }
}

async function findLocalUserByEmail(
  tx: Tx,
  email: string,
): Promise<{ userId: string; passwordHash: string; authProviderId: string } | null> {
  const rows = await tx
    .select({
      userId: users.id,
      passwordHash: userCredentials.passwordHash,
      authProviderId: users.authProviderId,
    })
    .from(userCredentials)
    .innerJoin(users, eq(userCredentials.userId, users.id))
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(2);
  if (rows.length !== 1) return null;
  return rows[0]!;
}

async function createLocalUser(
  tx: Tx,
  input: { email: string; name: string | null; password: string },
): Promise<{ userId: string }> {
  const email = input.email.trim().toLowerCase();
  const [existing] = await tx
    .select({ id: users.id })
    .from(userCredentials)
    .innerJoin(users, eq(userCredentials.userId, users.id))
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing) {
    throw AppError.conflict('ACCOUNT_EXISTS', 'An account with this email already exists');
  }
  const passwordHash = await hashPassword(input.password);
  const [user] = await tx
    .insert(users)
    .values({
      authProviderId: `local|${randomUUID()}`,
      email,
      name: input.name,
    })
    .returning({ id: users.id });
  await tx.insert(userCredentials).values({ userId: user!.id, passwordHash });
  return { userId: user!.id };
}

/* ------------------------------ Registration ----------------------------- */

localAuthRouter.post(
  '/auth/register-owner',
  registerLimit,
  asyncHandler(async (req, res) => {
    await requireLocalMode();
    const body = parseBody(
      req,
      z.object({
        email: EmailSchema,
        password: PasswordSchema,
        name: z.string().min(1).max(200),
      }),
    );
    const env = getEnv();
    const authorized = env.BOOTSTRAP_OWNER_EMAIL?.toLowerCase();
    if (!authorized) {
      throw AppError.serviceUnavailable(
        'BOOTSTRAP_NOT_CONFIGURED',
        'BOOTSTRAP_OWNER_EMAIL is not configured for this deployment',
      );
    }
    const db = getDb();
    const status = await getBootstrapStatus(db);
    if (status.bootstrapped) {
      throw AppError.conflict(
        'ALREADY_BOOTSTRAPPED',
        'This deployment already has an owner; new accounts require an invitation',
      );
    }
    if (body.email.trim().toLowerCase() !== authorized) {
      throw AppError.forbidden('This email is not authorized to create the owner account');
    }
    const policyError = validatePasswordPolicy(body.password, body.email);
    if (policyError) throw AppError.validation(policyError, { password: [policyError] });

    const session = await db.transaction(async (tx) => {
      const { userId } = await createLocalUser(tx, {
        email: body.email,
        name: body.name.trim(),
        password: body.password,
      });
      return createSession(tx, userId);
    });
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ok: true });
  }),
);

localAuthRouter.post(
  '/auth/register-with-invitation',
  registerLimit,
  asyncHandler(async (req, res) => {
    await requireLocalMode();
    const body = parseBody(
      req,
      z.object({
        token: z
          .string()
          .length(64)
          .regex(/^[0-9a-f]+$/),
        password: PasswordSchema,
        name: z.string().min(1).max(200),
      }),
    );
    const db = getDb();
    const { invitations } = await import('../db/schema/index');
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(body.token).digest('hex');

    const session = await db.transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      if (
        !invitation ||
        invitation.revokedAt ||
        invitation.acceptedAt ||
        invitation.expiresAt.getTime() < Date.now()
      ) {
        // Deliberately vague: token validity is the only credential here.
        throw AppError.notFound('Invitation is invalid or no longer usable');
      }
      const policyError = validatePasswordPolicy(body.password, invitation.email);
      if (policyError) throw AppError.validation(policyError, { password: [policyError] });

      const { userId } = await createLocalUser(tx, {
        email: invitation.email,
        name: body.name.trim(),
        password: body.password,
      });
      await acceptInvitationInTx(tx, {
        identity: { email: invitation.email },
        userId,
        token: body.token,
        correlationId: req.correlationId,
      });
      return createSession(tx, userId);
    });
    setSessionCookie(res, session.token, session.expiresAt);
    res.status(201).json({ ok: true });
  }),
);

/* -------------------------------- Sessions ------------------------------- */

localAuthRouter.post(
  '/auth/login',
  loginLimit,
  asyncHandler(async (req, res) => {
    await requireLocalMode();
    const body = parseBody(req, z.object({ email: EmailSchema, password: PasswordSchema }));
    const db = getDb();
    const session = await db.transaction(async (tx) => {
      const account = await findLocalUserByEmail(tx, body.email);
      let ok = false;
      if (account) {
        ok = await verifyPassword(body.password, account.passwordHash);
      } else {
        // Burn comparable time when the account is unknown so response
        // timing does not reveal which emails exist.
        await hashPassword(body.password);
      }
      if (!account || !ok) {
        throw AppError.unauthorized('Incorrect email or password');
      }
      return createSession(tx, account.userId);
    });
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({ ok: true });
  }),
);

localAuthRouter.post(
  '/auth/logout',
  asyncHandler(async (req, res) => {
    await requireLocalMode();
    const token = readSessionToken(req);
    if (token) await revokeSession(getDb(), token);
    clearSessionCookie(res);
    res.json({ ok: true });
  }),
);

localAuthRouter.post(
  '/auth/change-password',
  loginLimit,
  asyncHandler(async (req, res) => {
    await requireLocalMode();
    if (!req.identity || !req.userId) throw AppError.unauthorized();
    const body = parseBody(
      req,
      z.object({ currentPassword: PasswordSchema, newPassword: PasswordSchema }),
    );
    const policyError = validatePasswordPolicy(body.newPassword, req.identity.email);
    if (policyError) throw AppError.validation(policyError, { newPassword: [policyError] });
    const token = readSessionToken(req);
    const db = getDb();
    await db.transaction(async (tx) => {
      const [credential] = await tx
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, req.userId!))
        .for('update')
        .limit(1);
      if (!credential) throw AppError.unauthorized();
      const ok = await verifyPassword(body.currentPassword, credential.passwordHash);
      if (!ok) throw AppError.unauthorized('The current password is incorrect');
      await tx
        .update(userCredentials)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          passwordChangedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userCredentials.id, credential.id));
      // Every other session dies with the old password.
      await revokeOtherSessions(tx, req.userId!, token ?? undefined);
      if (req.org) {
        await writeAuditEvent(tx, {
          organizationId: req.org.organizationId,
          actorUserId: req.userId!,
          actorRole: req.org.roleKey,
          action: 'user.password_changed',
          entityType: 'user',
          entityId: req.userId!,
          correlationId: req.correlationId,
        });
      }
    });
    res.json({ ok: true });
  }),
);
