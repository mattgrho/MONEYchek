import { Router } from 'express';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getAuthAdapter } from '../auth/index';
import { getDb } from '../db/client';
import { companyProfiles, users } from '../db/schema/index';
import { requireAuth } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { asyncHandler, parseBody } from '../middleware/validate';
import { getBootstrapStatus, performBootstrap } from '../services/bootstrap';
import { acceptInvitation } from '../services/invitations';

export const sessionRouter = Router();

sessionRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const adapter = await getAuthAdapter();
    const db = getDb();
    const status = await getBootstrapStatus(db);
    if (!req.identity || !req.userId) {
      res.json({ authMode: adapter.mode, authenticated: false, bootstrapped: status.bootstrapped });
      return;
    }
    const [user] = await db.select().from(users).where(eq(users.id, req.userId)).limit(1);
    let company: unknown = null;
    if (req.org) {
      const [profile] = await db
        .select()
        .from(companyProfiles)
        .where(eq(companyProfiles.organizationId, req.org.organizationId))
        .limit(1);
      if (profile) {
        company = {
          displayName: profile.displayName,
          applicationName: profile.applicationName || `${profile.displayName} Books`,
          onboardingStep: profile.onboardingStep,
          onboardingCompleted: Boolean(profile.onboardingCompletedAt),
          homeCurrency: profile.homeCurrency,
          fiscalYearStartMonth: profile.fiscalYearStartMonth,
          dateFormat: profile.dateFormat,
        };
      }
    }
    res.json({
      authMode: adapter.mode,
      authenticated: true,
      bootstrapped: status.bootstrapped,
      user: user
        ? { id: user.id, email: user.email, name: user.name, imageUrl: user.imageUrl }
        : null,
      member: Boolean(req.org),
      org: req.org
        ? {
            organizationId: req.org.organizationId,
            roleKey: req.org.roleKey,
            roleName: req.org.roleName,
            permissions: req.org.permissions,
          }
        : null,
      company,
    });
  }),
);

const BootstrapSchema = z.object({ companyName: z.string().min(1).max(200) });

sessionRouter.post(
  '/bootstrap',
  requireAuth,
  rateLimit({ name: 'bootstrap', limit: 5, windowSeconds: 300 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(req, BootstrapSchema);
    const result = await performBootstrap(getDb(), {
      identity: req.identity!,
      companyName: body.companyName,
      correlationId: req.correlationId,
    });
    res.status(201).json(result);
  }),
);

const AcceptInvitationSchema = z.object({ token: z.string().min(16).max(256) });

sessionRouter.post(
  '/invitations/accept',
  requireAuth,
  rateLimit({ name: 'invitation-accept', limit: 10, windowSeconds: 300 }),
  asyncHandler(async (req, res) => {
    const body = parseBody(req, AcceptInvitationSchema);
    const result = await acceptInvitation(getDb(), {
      identity: req.identity!,
      userId: req.userId!,
      token: body.token,
      correlationId: req.correlationId,
    });
    res.json(result);
  }),
);
