import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  accounts,
  fiscalPeriods,
  financialAccountMetadata,
  manualJournals,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { ACCOUNT_CATEGORIES } from '../db/schema/ledger';
import { COA_TEMPLATES } from '../accounting/accounts';
import { accountBalances, accountRegister } from '../reports/financial';
import { closeChecklist } from '../reports/close-checklist';
import {
  adjustInventory,
  inventoryValuation,
  listInventoryAdjustments,
} from '../services/inventory';
import {
  createAccount,
  createManualJournal,
  deleteAccount,
  listManualJournals,
  postManualJournal,
  postOpeningBalances,
  reverseManualJournal,
  updateAccount,
  updateManualJournal,
} from '../services/ledger';
import { closePeriodsThrough, reopenPeriod } from '../accounting/periods';
import { writeAuditEvent } from '../accounting/audit';
import { companyToday } from '../lib/dates';
import { AppError } from '../lib/errors';
import { rateLimit } from '../middleware/rate-limit';

export const accountingRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/, 'Must be a positive decimal string');
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ------------------------------ Chart of accounts ----------------------- */

accountingRouter.get(
  '/coa-templates',
  requirePermission('accounts.view'),
  asyncHandler(async (_req, res) => {
    res.json({
      items: Object.entries(COA_TEMPLATES).map(([key, t]) => ({
        key,
        name: t.name,
        accounts: t.accounts,
      })),
    });
  }),
);

accountingRouter.get(
  '/accounts',
  requirePermission('accounts.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(
      req,
      z.object({
        withBalances: z.coerce.boolean().optional(),
        includeInactive: z.coerce.boolean().optional(),
      }),
    );
    const db = getDb();
    const rows = await db
      .select({
        id: accounts.id,
        number: accounts.number,
        name: accounts.name,
        category: accounts.category,
        detailType: accounts.detailType,
        normalBalance: accounts.normalBalance,
        systemKey: accounts.systemKey,
        parentAccountId: accounts.parentAccountId,
        postable: accounts.postable,
        active: accounts.active,
        description: accounts.description,
      })
      .from(accounts)
      .where(eq(accounts.organizationId, ctx.organizationId))
      .orderBy(asc(accounts.number), asc(accounts.name));
    const meta = await db
      .select()
      .from(financialAccountMetadata)
      .where(eq(financialAccountMetadata.organizationId, ctx.organizationId));
    const metaByAccount = new Map(meta.map((m) => [m.accountId, m]));
    let balances: Map<string, string> | null = null;
    if (query.withBalances) {
      const today = companyToday('America/New_York');
      const rowsB = await accountBalances(db, ctx.organizationId, today);
      balances = new Map(rowsB.map((b) => [b.accountId, b.balance]));
    }
    res.json({
      items: rows
        .filter((r) => query.includeInactive || r.active)
        .map((r) => ({
          ...r,
          bankKind: metaByAccount.get(r.id)?.kind ?? null,
          balance: balances?.get(r.id) ?? null,
        })),
    });
  }),
);

const CreateAccountSchema = z.object({
  name: z.string().min(1).max(120),
  number: z.string().max(20).optional().nullable(),
  category: z.enum(ACCOUNT_CATEGORIES),
  detailType: z.string().min(1).max(60),
  description: z.string().max(500).optional().nullable(),
  parentAccountId: z.string().uuid().optional().nullable(),
  institutionName: z.string().max(120).optional().nullable(),
  accountMask: z.string().max(10).optional().nullable(),
});

accountingRouter.post(
  '/accounts',
  requirePermission('accounts.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CreateAccountSchema);
    const result = await createAccount(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

accountingRouter.patch(
  '/accounts/:id',
  requirePermission('accounts.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      CreateAccountSchema.partial().extend({ active: z.boolean().optional() }),
    );
    await updateAccount(getDb(), ctx, id, body, req.correlationId);
    res.json({ ok: true });
  }),
);

accountingRouter.delete(
  '/accounts/:id',
  requirePermission('accounts.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    await deleteAccount(getDb(), ctx, id, req.correlationId);
    res.json({ ok: true });
  }),
);

accountingRouter.get(
  '/accounts/:id/register',
  requirePermission('accounts.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const query = parseQuery(
      req,
      z.object({ startDate: DateString.optional(), endDate: DateString.optional() }),
    );
    const db = getDb();
    const [account] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.organizationId, ctx.organizationId)))
      .limit(1);
    if (!account) throw AppError.notFound('Account not found');
    const register = await accountRegister(db, ctx.organizationId, id, query);
    res.json({
      account: {
        id: account.id,
        name: account.name,
        number: account.number,
        category: account.category,
      },
      ...register,
    });
  }),
);

/* ------------------------------ Opening balances ------------------------ */

const OpeningBalancesSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  date: DateString,
  lines: z
    .array(
      z
        .object({
          accountId: z.string().uuid(),
          debit: MoneyString.optional(),
          credit: MoneyString.optional(),
        })
        .refine((l) => (l.debit === undefined) !== (l.credit === undefined), {
          message: 'Each line needs exactly one of debit or credit',
        }),
    )
    .min(1)
    .max(200),
});

accountingRouter.post(
  '/opening-balances',
  requirePermission('journals.post'),
  rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, OpeningBalancesSchema);
    const result = await postOpeningBalances(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* ------------------------------ Manual journals ------------------------- */

const JournalLineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: MoneyString.optional(),
    credit: MoneyString.optional(),
    memo: z.string().max(500).optional(),
  })
  .refine((l) => Boolean(l.debit) !== Boolean(l.credit), {
    message: 'Each line needs exactly one of debit or credit',
  });

const CreateJournalSchema = z.object({
  journalDate: DateString,
  memo: z.string().max(1000).optional(),
  lines: z.array(JournalLineSchema).min(2).max(200),
});

accountingRouter.get(
  '/manual-journals',
  requirePermission('journals.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    res.json({ items: await listManualJournals(getDb(), ctx) });
  }),
);

accountingRouter.get(
  '/manual-journals/:id',
  requirePermission('journals.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const [row] = await getDb()
      .select()
      .from(manualJournals)
      .where(and(eq(manualJournals.id, id), eq(manualJournals.organizationId, ctx.organizationId)))
      .limit(1);
    if (!row) throw AppError.notFound('Journal entry not found');
    res.json(row);
  }),
);

accountingRouter.post(
  '/manual-journals',
  requirePermission('journals.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CreateJournalSchema);
    const result = await createManualJournal(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

accountingRouter.patch(
  '/manual-journals/:id',
  requirePermission('journals.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, CreateJournalSchema.partial());
    await updateManualJournal(getDb(), ctx, id, body);
    res.json({ ok: true });
  }),
);

const PostSchema = z.object({ idempotencyKey: z.string().min(8).max(200) });

accountingRouter.post(
  '/manual-journals/:id/post',
  requirePermission('journals.post'),
  rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, PostSchema);
    const result = await postManualJournal(
      getDb(),
      ctx,
      id,
      body.idempotencyKey,
      req.correlationId,
    );
    res.json(result);
  }),
);

const ReverseSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  reason: z.string().min(3).max(500),
  postingDate: DateString,
});

accountingRouter.post(
  '/manual-journals/:id/reverse',
  requirePermission('journals.reverse'),
  rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, ReverseSchema);
    const result = await reverseManualJournal(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

/* -------------------------------- Inventory ------------------------------ */

accountingRouter.get(
  '/inventory/valuation',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    res.json(await inventoryValuation(getDb(), ctx.organizationId));
  }),
);

accountingRouter.get(
  '/inventory/adjustments',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const items = await listInventoryAdjustments(getDb(), ctx.organizationId);
    const { roundMoney } = await import('@shared/money');
    res.json({
      items: items.map((a) => ({ ...a, totalValue: roundMoney(a.totalValue) })),
    });
  }),
);

accountingRouter.post(
  '/inventory/adjustments',
  requirePermission('products.edit'),
  rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(
      req,
      z.object({
        productId: z.string().uuid(),
        adjustmentDate: DateString,
        direction: z.enum(['increase', 'decrease']),
        quantity: MoneyString,
        unitCost: MoneyString.optional(),
        reason: z.string().min(3).max(500),
        idempotencyKey: z.string().min(8).max(200),
      }),
    );
    const result = await adjustInventory(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* ------------------------------ Periods & close -------------------------- */

accountingRouter.get(
  '/periods',
  requirePermission('periods.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select()
      .from(fiscalPeriods)
      .where(eq(fiscalPeriods.organizationId, ctx.organizationId))
      .orderBy(asc(fiscalPeriods.startDate));
    res.json({ items: rows });
  }),
);

accountingRouter.get(
  '/periods/close-checklist',
  requirePermission('periods.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, z.object({ through: DateString }));
    res.json(await closeChecklist(getDb(), ctx.organizationId, query.through));
  }),
);

const CloseSchema = z.object({
  throughDate: DateString,
  mode: z.enum(['soft_closed', 'hard_closed']),
});

accountingRouter.post(
  '/periods/close',
  requirePermission('periods.close'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CloseSchema);
    const db = getDb();
    const count = await db.transaction(async (tx) => {
      const n = await closePeriodsThrough(
        tx,
        ctx.organizationId,
        body.throughDate,
        body.mode,
        ctx.userId,
      );
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'period.closed',
        entityType: 'fiscal_period',
        payload: { throughDate: body.throughDate, mode: body.mode, periodsAffected: n },
        correlationId: req.correlationId,
      });
      return n;
    });
    res.json({ closed: count });
  }),
);

const ReopenSchema = z.object({ reason: z.string().min(3).max(500) });

accountingRouter.post(
  '/periods/:id/reopen',
  requirePermission('periods.reopen'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, ReopenSchema);
    const db = getDb();
    await db.transaction(async (tx) => {
      await reopenPeriod(tx, ctx.organizationId, id, ctx.userId, body.reason);
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'period.reopened',
        entityType: 'fiscal_period',
        entityId: id,
        reason: body.reason,
        correlationId: req.correlationId,
      });
    });
    res.json({ ok: true });
  }),
);
