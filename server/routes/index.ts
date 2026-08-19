import { Router } from 'express';
import { attachAuth, requireAuth, requireMember } from '../middleware/auth';
import { sessionRouter } from './session';
import { usersRouter } from './users';
import { dashboardRouter } from './dashboard';

/**
 * /api/v1 composition. Every router below attachAuth sees req.identity /
 * req.org; authorization is enforced per route with requirePermission.
 */
export function buildApiRouter(): Router {
  const api = Router();
  api.use(attachAuth);
  api.use(sessionRouter);
  api.use(requireAuth, requireMember, usersRouter);
  api.use(requireAuth, requireMember, dashboardRouter);
  return api;
}
