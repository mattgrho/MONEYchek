import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { companyProfiles } from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/validate';
import { getDashboardData } from '../reports/dashboard';
import { companyToday } from '../lib/dates';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/dashboard',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    const [profile] = await db
      .select({ timeZone: companyProfiles.timeZone })
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, ctx.organizationId))
      .limit(1);
    const today = companyToday(profile?.timeZone ?? 'America/New_York');
    res.json(await getDashboardData(db, ctx.organizationId, today));
  }),
);
