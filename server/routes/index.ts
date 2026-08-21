import { Router } from 'express';
import { attachAuth, requireAuth, requireMember } from '../middleware/auth';
import { sessionRouter } from './session';
import { localAuthRouter } from './local-auth';
import { usersRouter } from './users';
import { dashboardRouter } from './dashboard';
import { accountingRouter } from './accounting';
import { reportsRouter } from './reports';
import { onboardingRouter } from './onboarding';
import { salesRouter } from './sales';
import { arRouter } from './ar';
import { apRouter } from './ap';
import { purchaseOrdersRouter } from './purchase-orders';
import { retainersRouter } from './retainers';
import { salesTaxRouter } from './sales-tax';
import { bankingRouter } from './banking';
import { documentsRouter } from './documents';
import { exportsRouter } from './exports';
import { attachmentsRouter } from './attachments';

/**
 * /api/v1 composition. Every router below attachAuth sees req.identity /
 * req.org; authorization is enforced per route with requirePermission.
 */
export function buildApiRouter(): Router {
  const api = Router();
  api.use(attachAuth);
  api.use(sessionRouter);
  api.use(localAuthRouter);
  api.use(requireAuth, requireMember, usersRouter);
  api.use(requireAuth, requireMember, dashboardRouter);
  api.use(requireAuth, requireMember, accountingRouter);
  api.use(requireAuth, requireMember, reportsRouter);
  api.use(requireAuth, requireMember, onboardingRouter);
  api.use(requireAuth, requireMember, salesRouter);
  api.use(requireAuth, requireMember, arRouter);
  api.use(requireAuth, requireMember, apRouter);
  api.use(requireAuth, requireMember, purchaseOrdersRouter);
  api.use(requireAuth, requireMember, retainersRouter);
  api.use(requireAuth, requireMember, salesTaxRouter);
  api.use(requireAuth, requireMember, bankingRouter);
  api.use(requireAuth, requireMember, documentsRouter);
  api.use(requireAuth, requireMember, exportsRouter);
  api.use(requireAuth, requireMember, attachmentsRouter);
  return api;
}
