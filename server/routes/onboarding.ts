import { Router } from 'express';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  accounts,
  brandSettings,
  companyProfiles,
  purchasingSettings,
  salesSettings,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody } from '../middleware/validate';
import { applyChartTemplate } from '../accounting/accounts';
import { bestForeground, contrastRatio, hexToHslTriplet, isHexColor } from '../lib/colors';
import { writeAuditEvent } from '../accounting/audit';
import { AppError } from '../lib/errors';

/**
 * Resumable onboarding. Steps: company -> brand -> accounting -> chart ->
 * review. Progress persists in company_profiles.onboarding_step; every PATCH
 * can be revisited later from Settings without code edits.
 */
export const onboardingRouter = Router();

const STEPS = ['company', 'brand', 'accounting', 'chart', 'review', 'done'] as const;

onboardingRouter.get(
  '/onboarding/state',
  requirePermission('company.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    const [profile] = await db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, ctx.organizationId))
      .limit(1);
    const [brand] = await db
      .select()
      .from(brandSettings)
      .where(eq(brandSettings.organizationId, ctx.organizationId))
      .limit(1);
    const [salesRow] = await db
      .select()
      .from(salesSettings)
      .where(eq(salesSettings.organizationId, ctx.organizationId))
      .limit(1);
    const [purchRow] = await db
      .select()
      .from(purchasingSettings)
      .where(eq(purchasingSettings.organizationId, ctx.organizationId))
      .limit(1);
    const accountCount = await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM accounts WHERE organization_id = ${ctx.organizationId}`,
    );
    res.json({
      step: profile?.onboardingStep ?? 'company',
      completed: Boolean(profile?.onboardingCompletedAt),
      profile,
      brand,
      sales: salesRow,
      purchasing: purchRow,
      accountCount: (accountCount.rows[0] as { n: number }).n,
    });
  }),
);

const CompanyStepSchema = z.object({
  legalName: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  applicationName: z.string().max(120).optional().nullable(),
  entityType: z.string().max(60).optional().nullable(),
  industry: z.string().max(120).optional().nullable(),
  phone: z.string().max(40).optional().nullable(),
  supportEmail: z
    .string()
    .email()
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  website: z.string().max(200).optional().nullable(),
  timeZone: z.string().max(60).optional(),
  addresses: z
    .record(
      z.object({
        line1: z.string().max(120).optional(),
        line2: z.string().max(120).optional(),
        city: z.string().max(80).optional(),
        region: z.string().max(80).optional(),
        postalCode: z.string().max(20).optional(),
        country: z.string().max(60).optional(),
      }),
    )
    .optional(),
  legalFooter: z.string().max(2000).optional().nullable(),
  paymentInstructions: z.string().max(2000).optional().nullable(),
});

onboardingRouter.patch(
  '/onboarding/company',
  requirePermission('company.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CompanyStepSchema);
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx
        .update(companyProfiles)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(companyProfiles.organizationId, ctx.organizationId));
      // Advance only while actually on this step (the endpoint doubles as the
      // ordinary Settings editor after onboarding).
      await tx
        .update(companyProfiles)
        .set({ onboardingStep: advance('company') })
        .where(
          sql`${companyProfiles.organizationId} = ${ctx.organizationId} AND ${companyProfiles.onboardingStep} = 'company'`,
        );
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'company.updated',
        entityType: 'company_profile',
        payload: { fields: Object.keys(body) },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true, nextStep: advance('company') });
  }),
);

const HexColor = z.string().refine(isHexColor, 'Use a 6-digit hex color like #1d4ed8');

const BrandStepSchema = z.object({
  primary: HexColor.optional(),
  accent: HexColor.optional(),
  success: HexColor.optional(),
  warning: HexColor.optional(),
  danger: HexColor.optional(),
  sidebar: HexColor.optional(),
  themeMode: z.enum(['light', 'dark', 'system']).optional(),
  radius: z.enum(['0rem', '0.25rem', '0.5rem', '0.75rem', '1rem']).optional(),
  applicationName: z.string().max(120).optional().nullable(),
});

/**
 * Turns admin hex picks into accessible token pairs. Foregrounds are derived
 * automatically; low-contrast selections generate explicit warnings.
 */
function buildTokens(input: z.infer<typeof BrandStepSchema>): {
  tokens: Record<string, string>;
  warnings: string[];
} {
  const tokens: Record<string, string> = {};
  const warnings: string[] = [];
  const pairs: [keyof typeof input, string][] = [
    ['primary', 'primary'],
    ['accent', 'accent'],
    ['success', 'success'],
    ['warning', 'warning'],
    ['danger', 'destructive'],
  ];
  for (const [field, token] of pairs) {
    const hex = input[field] as string | undefined;
    if (!hex) continue;
    tokens[token] = hexToHslTriplet(hex);
    const fg = bestForeground(hex);
    tokens[`${token}-foreground`] = hexToHslTriplet(fg);
    const ratio = contrastRatio(hex, fg);
    if (ratio < 4.5) {
      warnings.push(
        `${String(field)} (${hex}) reaches only ${ratio.toFixed(2)}:1 contrast with its text color; WCAG AA needs 4.5:1. Consider a darker or lighter shade.`,
      );
    }
    if (token === 'primary') tokens['ring'] = hexToHslTriplet(hex);
  }
  if (input.sidebar) {
    tokens['sidebar'] = hexToHslTriplet(input.sidebar);
    const fg = bestForeground(input.sidebar);
    tokens['sidebar-foreground'] = hexToHslTriplet(fg);
    tokens['sidebar-accent'] = hexToHslTriplet(input.sidebar) // slightly lighter accent derived client-side is
      // unnecessary: reuse the same hue at a fixed offset by mixing with fg.
      .replace(/(\d+)%$/, (m) => `${Math.min(96, Number.parseInt(m, 10) + 10)}%`);
    tokens['sidebar-accent-foreground'] = hexToHslTriplet(fg);
    const ratio = contrastRatio(input.sidebar, fg);
    if (ratio < 4.5) {
      warnings.push(`sidebar (${input.sidebar}) has low contrast (${ratio.toFixed(2)}:1).`);
    }
  }
  return { tokens, warnings };
}

onboardingRouter.patch(
  '/onboarding/brand',
  requirePermission('brand.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, BrandStepSchema);
    const { tokens, warnings } = buildTokens(body);
    const db = getDb();
    await db.transaction(async (tx) => {
      const [brand] = await tx
        .select()
        .from(brandSettings)
        .where(eq(brandSettings.organizationId, ctx.organizationId))
        .for('update')
        .limit(1);
      if (!brand) throw AppError.internal('Brand settings row missing');
      await tx
        .update(brandSettings)
        .set({
          tokens: { ...brand.tokens, ...tokens },
          ...(body.themeMode ? { themeMode: body.themeMode } : {}),
          ...(body.radius ? { radius: body.radius } : {}),
          brandVersion: brand.brandVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(brandSettings.id, brand.id));
      if (body.applicationName !== undefined) {
        await tx
          .update(companyProfiles)
          .set({ applicationName: body.applicationName, updatedAt: new Date() })
          .where(eq(companyProfiles.organizationId, ctx.organizationId));
      }
      await tx
        .update(companyProfiles)
        .set({ onboardingStep: advance('brand') })
        .where(
          sql`${companyProfiles.organizationId} = ${ctx.organizationId} AND ${companyProfiles.onboardingStep} = 'brand'`,
        );
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'brand.updated',
        entityType: 'brand_settings',
        payload: { tokens: Object.keys(tokens), warnings },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true, warnings, nextStep: advance('brand') });
  }),
);

const AccountingStepSchema = z.object({
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  bookkeepingStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  homeCurrency: z.literal('USD'),
  accountNumbersEnabled: z.boolean().optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
});

onboardingRouter.patch(
  '/onboarding/accounting',
  requirePermission('company.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, AccountingStepSchema);
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx
        .update(companyProfiles)
        .set({
          fiscalYearStartMonth: body.fiscalYearStartMonth,
          bookkeepingStartDate: body.bookkeepingStartDate,
          homeCurrency: body.homeCurrency,
          updatedAt: new Date(),
        })
        .where(eq(companyProfiles.organizationId, ctx.organizationId));
      await tx
        .update(companyProfiles)
        .set({ onboardingStep: advance('accounting') })
        .where(
          sql`${companyProfiles.organizationId} = ${ctx.organizationId} AND ${companyProfiles.onboardingStep} = 'accounting'`,
        );
      if (body.defaultTermsDays !== undefined) {
        await tx
          .update(salesSettings)
          .set({ defaultTermsDays: body.defaultTermsDays, updatedAt: new Date() })
          .where(eq(salesSettings.organizationId, ctx.organizationId));
      }
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'accounting_settings.updated',
        entityType: 'accounting_settings',
        payload: { fields: Object.keys(body) },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true, nextStep: advance('accounting') });
  }),
);

const ChartStepSchema = z.object({ templateKey: z.string().min(1).max(60) });

onboardingRouter.post(
  '/onboarding/chart-template',
  requirePermission('accounts.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, ChartStepSchema);
    const db = getDb();
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.organizationId, ctx.organizationId))
        .limit(1);
      if (existing[0]) {
        throw AppError.conflict(
          'CHART_EXISTS',
          'A chart of accounts already exists; add or edit accounts individually instead',
        );
      }
      await applyChartTemplate(tx, ctx.organizationId, body.templateKey);
      await tx
        .update(companyProfiles)
        .set({ onboardingStep: advance('chart'), updatedAt: new Date() })
        .where(eq(companyProfiles.organizationId, ctx.organizationId));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'chart_template.applied',
        entityType: 'accounts',
        payload: { templateKey: body.templateKey },
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true, nextStep: advance('chart') });
  }),
);

onboardingRouter.post(
  '/onboarding/complete',
  requirePermission('company.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    await db.transaction(async (tx) => {
      const [profile] = await tx
        .select()
        .from(companyProfiles)
        .where(eq(companyProfiles.organizationId, ctx.organizationId))
        .for('update')
        .limit(1);
      if (!profile) throw AppError.internal();
      if (!profile.displayName) {
        throw AppError.unprocessable('ONBOARDING_INCOMPLETE', 'Company identity is not finished');
      }
      const [hasAccounts] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.organizationId, ctx.organizationId))
        .limit(1);
      if (!hasAccounts) {
        throw AppError.unprocessable(
          'ONBOARDING_INCOMPLETE',
          'Choose a chart of accounts before finishing setup',
        );
      }
      await tx
        .update(companyProfiles)
        .set({ onboardingStep: 'done', onboardingCompletedAt: new Date(), updatedAt: new Date() })
        .where(eq(companyProfiles.id, profile.id));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'onboarding.completed',
        entityType: 'company_profile',
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true });
  }),
);

function advance(current: (typeof STEPS)[number]): string {
  const idx = STEPS.indexOf(current);
  return STEPS[Math.min(idx + 1, STEPS.length - 1)]!;
}
