import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { AuthAdapter, AuthenticatedIdentity } from './adapter';
import { getDb, type DbOrTx } from '../db/client';
import { authSessions, users } from '../db/schema/index';
import { getEnv } from '../config/env';

/**
 * First-party email + password provider ("local"). No external identity
 * service is involved:
 *  - sessions are 256-bit random tokens stored only as SHA-256 hashes,
 *    carried in an httpOnly SameSite=Lax cookie (Secure in production);
 *  - state-changing requests additionally require the custom
 *    X-Requested-With header the SPA always sends, so a cross-site form
 *    post (which cannot set custom headers) never authenticates — CSRF
 *    defense on top of SameSite;
 *  - account creation is closed: only the configured bootstrap owner email
 *    (pre-bootstrap) or the holder of a live invitation token can register.
 *
 * Trust model, stated plainly: there is no third-party email verification.
 * The owner's email is trusted because the deployment operator configured
 * BOOTSTRAP_OWNER_EMAIL; a member's email is trusted because their account
 * can only be created through the single-use invitation token issued to
 * exactly that email.
 */

export const SESSION_COOKIE = 'ledgeros_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, fixed expiry
const LAST_SEEN_TOUCH_MS = 60 * 60 * 1000; // throttle lastSeenAt writes

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: DbOrTx,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(authSessions).values({
    tokenHash: hashSessionToken(token),
    userId,
    expiresAt,
  });
  // Opportunistic cleanup of long-expired sessions (no cron needed).
  await db
    .delete(authSessions)
    .where(lt(authSessions.expiresAt, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)));
  return { token, expiresAt };
}

export async function revokeSession(db: DbOrTx, token: string): Promise<void> {
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(eq(authSessions.tokenHash, hashSessionToken(token)));
}

/** Revokes every session for a user except (optionally) the current one. */
export async function revokeOtherSessions(
  db: DbOrTx,
  userId: string,
  keepToken?: string,
): Promise<void> {
  const conditions = [eq(authSessions.userId, userId), isNull(authSessions.revokedAt)];
  if (keepToken) {
    conditions.push(sql`${authSessions.tokenHash} <> ${hashSessionToken(keepToken)}`);
  }
  await db
    .update(authSessions)
    .set({ revokedAt: new Date() })
    .where(and(...conditions));
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const secure = getEnv().NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response): void {
  const secure = getEnv().NODE_ENV === 'production';
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === SESSION_COOKIE) {
      const value = rest.join('=');
      if (/^[0-9a-f]{64}$/.test(value)) return value;
      return null;
    }
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createLocalAdapter(): AuthAdapter {
  return {
    mode: 'local',
    clientConfig() {
      return { mode: 'local' };
    },
    async authenticate(req: Request): Promise<AuthenticatedIdentity | null> {
      const token = readSessionToken(req);
      if (!token) return null;
      // CSRF: cookie-authenticated writes must carry the SPA's custom
      // header; a cross-site form post cannot set one.
      if (!SAFE_METHODS.has(req.method) && req.headers['x-requested-with'] !== 'fetch') {
        return null;
      }
      const db = getDb();
      const [row] = await db
        .select({
          sessionId: authSessions.id,
          lastSeenAt: authSessions.lastSeenAt,
          userId: users.id,
          authProviderId: users.authProviderId,
          email: users.email,
          name: users.name,
          imageUrl: users.imageUrl,
        })
        .from(authSessions)
        .innerJoin(users, eq(authSessions.userId, users.id))
        .where(
          and(
            eq(authSessions.tokenHash, hashSessionToken(token)),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, new Date()),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_TOUCH_MS) {
        await db
          .update(authSessions)
          .set({ lastSeenAt: new Date() })
          .where(eq(authSessions.id, row.sessionId));
      }
      return {
        authProviderId: row.authProviderId,
        email: row.email,
        emailVerified: true,
        name: row.name ?? undefined,
        imageUrl: row.imageUrl ?? undefined,
      };
    },
  };
}
