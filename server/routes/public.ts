import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { getAuthAdapter } from '../auth/index';
import { getDb } from '../db/client';
import { brandSettings, companyProfiles } from '../db/schema/index';
import { getPrimaryOrganizationId } from '../services/identity';
import { getBootstrapStatus } from '../services/bootstrap';
import { asyncHandler } from '../middleware/validate';

/**
 * Pre-authentication surfaces. The brand is resolved on the server from the
 * protected deployment binding; no client-supplied organization id, hostname
 * override, or query parameter is ever honored.
 */
export const publicRouter = Router();

publicRouter.get(
  '/auth-config',
  asyncHandler(async (_req, res) => {
    const adapter = await getAuthAdapter();
    const status = await getBootstrapStatus(getDb());
    res.setHeader('Cache-Control', 'no-store, private');
    res.json({ ...adapter.clientConfig(), bootstrapped: status.bootstrapped });
  }),
);

publicRouter.get(
  '/brand-bootstrap',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const orgId = await getPrimaryOrganizationId(db);
    res.setHeader('Cache-Control', 'no-store, private');
    if (!orgId) {
      // Neutral pre-onboarding fallback; the internal code name is never shown.
      res.json({
        configured: false,
        displayName: null,
        applicationName: null,
        tokens: {},
        themeMode: 'system',
        radius: '0.5rem',
        brandVersion: 0,
      });
      return;
    }
    const [profile] = await db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, orgId))
      .limit(1);
    const [brand] = await db
      .select()
      .from(brandSettings)
      .where(eq(brandSettings.organizationId, orgId))
      .limit(1);
    res.json({
      configured: true,
      displayName: profile?.displayName || null,
      applicationName:
        profile?.applicationName || (profile?.displayName ? `${profile.displayName} Books` : null),
      tokens: brand?.tokens ?? {},
      themeMode: brand?.themeMode ?? 'system',
      radius: brand?.radius ?? '0.5rem',
      brandVersion: brand?.brandVersion ?? 1,
      hasLogo: Boolean(brand?.primaryLogoAttachmentId),
    });
  }),
);

/**
 * The administrator-approved primary logo (raster image only). Public by
 * design: the login page shows it before authentication. Content is limited
 * to validated PNG/JPEG/WebP brand assets.
 */
publicRouter.get(
  '/brand-logo',
  asyncHandler(async (_req, res) => {
    const db = getDb();
    const orgId = await getPrimaryOrganizationId(db);
    if (!orgId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo configured' } });
      return;
    }
    const [brand] = await db
      .select()
      .from(brandSettings)
      .where(eq(brandSettings.organizationId, orgId))
      .limit(1);
    if (!brand?.primaryLogoAttachmentId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo configured' } });
      return;
    }
    const { attachments } = await import('../db/schema/index');
    const [logo] = await db
      .select()
      .from(attachments)
      .where(eq(attachments.id, brand.primaryLogoAttachmentId))
      .limit(1);
    if (!logo || !['image/png', 'image/jpeg', 'image/webp'].includes(logo.mimeType)) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No logo configured' } });
      return;
    }
    const { getStorage } = await import('../storage/adapter');
    const data = await getStorage().get(logo.storageKey);
    res.setHeader('Content-Type', logo.mimeType);
    res.setHeader('Cache-Control', `public, max-age=300`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(data);
  }),
);
