import { Router } from 'express';
import { z } from 'zod';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { auditEvents, companyProfiles } from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseQuery } from '../middleware/validate';
import {
  balanceSheet,
  generalLedgerAvailable,
  journalReport,
  profitAndLoss,
  trialBalance,
} from '../reports/index';
import { verifyAuditChain } from '../accounting/audit';
import { companyToday } from '../lib/dates';

export const reportsRouter = Router();

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function fyStartMonth(organizationId: string): Promise<{ month: number; timeZone: string }> {
  const [profile] = await getDb()
    .select({
      month: companyProfiles.fiscalYearStartMonth,
      timeZone: companyProfiles.timeZone,
    })
    .from(companyProfiles)
    .where(eq(companyProfiles.organizationId, organizationId))
    .limit(1);
  return { month: profile?.month ?? 1, timeZone: profile?.timeZone ?? 'America/New_York' };
}

reportsRouter.get(
  '/reports/trial-balance',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { timeZone } = await fyStartMonth(ctx.organizationId);
    const query = parseQuery(
      req,
      z.object({ asOf: DateString.optional(), format: z.enum(['json', 'csv']).default('json') }),
    );
    const asOf = query.asOf ?? companyToday(timeZone);
    const report = await trialBalance(getDb(), ctx.organizationId, asOf);
    if (query.format === 'csv') {
      const { toCsv } = await import('../lib/csv-out');
      const csv = toCsv(
        ['Account #', 'Account', 'Debit', 'Credit'],
        [
          ...report.rows.map((r) => [r.number, r.name, r.debit, r.credit]),
          ['', 'TOTAL', report.totalDebits, report.totalCredits],
        ],
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="trial-balance-${asOf}.csv"`);
      res.setHeader('Cache-Control', 'no-store, private');
      res.send(csv);
      return;
    }
    res.json(report);
  }),
);

reportsRouter.get(
  '/reports/profit-and-loss',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { timeZone } = await fyStartMonth(ctx.organizationId);
    const today = companyToday(timeZone);
    const query = parseQuery(
      req,
      z.object({
        startDate: DateString.optional(),
        endDate: DateString.optional(),
        format: z.enum(['json', 'csv']).default('json'),
      }),
    );
    const endDate = query.endDate ?? today;
    const startDate = query.startDate ?? `${endDate.slice(0, 4)}-01-01`;
    const report = await profitAndLoss(getDb(), ctx.organizationId, startDate, endDate);
    if (query.format === 'csv') {
      const { toCsv } = await import('../lib/csv-out');
      const rows: unknown[][] = [];
      for (const section of [
        report.income,
        report.cogs,
        report.expenses,
        report.otherIncome,
        report.otherExpenses,
      ]) {
        if (section.rows.length === 0) continue;
        rows.push([section.label, '', '']);
        for (const r of section.rows)
          rows.push(['', `${r.number ?? ''} ${r.name}`.trim(), r.amount]);
        rows.push(['', `Total ${section.label.toLowerCase()}`, section.total]);
      }
      rows.push(['', 'Gross profit', report.grossProfit]);
      rows.push(['', 'NET INCOME', report.netIncome]);
      const csv = toCsv(['Section', 'Account', 'Amount'], rows);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="profit-and-loss-${startDate}-to-${endDate}.csv"`,
      );
      res.setHeader('Cache-Control', 'no-store, private');
      res.send(csv);
      return;
    }
    res.json(report);
  }),
);

reportsRouter.get(
  '/reports/balance-sheet',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { month, timeZone } = await fyStartMonth(ctx.organizationId);
    const query = parseQuery(req, z.object({ asOf: DateString.optional() }));
    const asOf = query.asOf ?? companyToday(timeZone);
    res.json(await balanceSheet(getDb(), ctx.organizationId, asOf, month));
  }),
);

reportsRouter.get(
  '/reports/journal',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { timeZone } = await fyStartMonth(ctx.organizationId);
    const today = companyToday(timeZone);
    const query = parseQuery(
      req,
      z.object({ startDate: DateString.optional(), endDate: DateString.optional() }),
    );
    const endDate = query.endDate ?? today;
    const startDate = query.startDate ?? `${endDate.slice(0, 4)}-01-01`;
    res.json({ items: await journalReport(getDb(), ctx.organizationId, startDate, endDate) });
  }),
);

reportsRouter.get(
  '/reports/general-ledger',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { timeZone } = await fyStartMonth(ctx.organizationId);
    const today = companyToday(timeZone);
    const query = parseQuery(
      req,
      z.object({
        startDate: DateString.optional(),
        endDate: DateString.optional(),
        accountId: z.string().uuid().optional(),
      }),
    );
    const endDate = query.endDate ?? today;
    const startDate = query.startDate ?? `${endDate.slice(0, 4)}-01-01`;
    res.json(
      await generalLedgerAvailable(
        getDb(),
        ctx.organizationId,
        startDate,
        endDate,
        query.accountId,
      ),
    );
  }),
);

reportsRouter.get(
  '/audit-log',
  requirePermission('audit.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(
      req,
      z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        beforeSeq: z.coerce.number().int().optional(),
      }),
    );
    const db = getDb();
    const rows = await db
      .select({
        seq: auditEvents.seq,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        actorUserId: auditEvents.actorUserId,
        actorRole: auditEvents.actorRole,
        reason: auditEvents.reason,
        payload: auditEvents.payload,
        correlationId: auditEvents.correlationId,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, ctx.organizationId))
      .orderBy(desc(auditEvents.seq))
      .limit(query.limit);
    res.json({ items: rows });
  }),
);

reportsRouter.get(
  '/audit-log/verify',
  requirePermission('audit.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    res.json(await verifyAuditChain(getDb(), ctx.organizationId));
  }),
);
