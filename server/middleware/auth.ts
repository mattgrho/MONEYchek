import type { NextFunction, Request, Response } from 'express';
import type { AuthenticatedIdentity } from '../auth/adapter';
import { getAuthAdapter } from '../auth/index';
import { getDb } from '../db/client';
import { AppError } from '../lib/errors';
import { hasPermission, type PermissionKey } from '@shared/permissions';
import { resolveOrgContext, syncUser, type OrgContext } from '../services/identity';

declare module 'express-serve-static-core' {
  interface Request {
    identity: AuthenticatedIdentity | null;
    userId: string | null;
    org: OrgContext | null;
  }
}

/** Resolves identity (if any) for every API request. */
export async function attachAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const adapter = await getAuthAdapter();
    req.identity = await adapter.authenticate(req);
    req.userId = null;
    req.org = null;
    if (req.identity) {
      const user = await syncUser(getDb(), req.identity);
      req.userId = user.id;
      req.org = await resolveOrgContext(getDb(), user.id);
    }
    next();
  } catch (err) {
    next(err);
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const adapter = await getAuthAdapter();
  if (adapter.mode === 'disabled') {
    next(
      AppError.serviceUnavailable(
        'AUTH_NOT_CONFIGURED',
        'Authentication is not configured for this deployment yet',
      ),
    );
    return;
  }
  if (!req.identity || !req.userId) {
    next(AppError.unauthorized());
    return;
  }
  next();
}

/** Requires an active membership in the primary organization. */
export function requireMember(req: Request, _res: Response, next: NextFunction): void {
  if (!req.identity || !req.userId) {
    next(AppError.unauthorized());
    return;
  }
  if (!req.org) {
    next(AppError.forbidden('You are not a member of this company'));
    return;
  }
  next();
}

export function requirePermission(key: PermissionKey) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.identity || !req.userId) {
      next(AppError.unauthorized());
      return;
    }
    if (!req.org) {
      next(AppError.forbidden('You are not a member of this company'));
      return;
    }
    if (!hasPermission(req.org.permissions, key)) {
      next(AppError.forbidden());
      return;
    }
    next();
  };
}

/** Convenience: throws unless the request carries an org context. */
export function orgCtx(req: Request): OrgContext {
  if (!req.org) throw AppError.forbidden('You are not a member of this company');
  return req.org;
}
