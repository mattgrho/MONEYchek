import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  accounts,
  bankFeedItems,
  bankImportBatches,
  bankRules,
  financialAccountMetadata,
  reconciliations,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  abandonReconciliation,
  addFromFeedItem,
  completeReconciliation,
  importBankCsv,
  matchFeedItem,
  reconciliationStatus,
  recordTransfer,
  setFeedItemState,
  startReconciliation,
  suggestMatches,
  toggleReconciliationItem,
} from '../services/banking';
import { accountRegister } from '../reports/financial';
import { writeAuditEvent } from '../accounting/audit';

export const bankingRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^-?\d+(\.\d+)?$/);
const PositiveMoney = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IdemKey = z.string().min(8).max(200);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });
const importLimit = rateLimit({ name: 'imports', limit: 30, windowSeconds: 300 });

/* ---------------------------- Accounts & register ------------------------- */

bankingRouter.get(
  '/banking/accounts',
  requirePermission('banking.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    const rows = await db
      .select({
        accountId: financialAccountMetadata.accountId,
        kind: financialAccountMetadata.kind,
        institutionName: financialAccountMetadata.institutionName,
        accountMask: financialAccountMetadata.accountMask,
        name: accounts.name,
        number: accounts.number,
        active: accounts.active,
      })
      .from(financialAccountMetadata)
      .innerJoin(accounts, eq(financialAccountMetadata.accountId, accounts.id))
      .where(eq(financialAccountMetadata.organizationId, ctx.organizationId))
      .orderBy(asc(accounts.name));
    // Book balance, cleared balance, last reconciliation per account.
    const { roundMoney, add, sub } = await import('@shared/money');
    const items = [];
    for (const row of rows.filter((r) => r.active)) {
      const register = await accountRegister(db, ctx.organizationId, row.accountId, {
        limit: 1000,
      });
      let cleared = '0';
      for (const line of register.rows) {
        if (line.cleared) cleared = add(cleared, sub(line.debit, line.credit));
      }
      const [lastRecon] = await db
        .select({
          endDate: reconciliations.statementEndDate,
          endingBalance: reconciliations.endingBalance,
        })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.organizationId, ctx.organizationId),
            eq(reconciliations.accountId, row.accountId),
            eq(reconciliations.status, 'completed'),
          ),
        )
        .orderBy(desc(reconciliations.statementEndDate))
        .limit(1);
      items.push({
        ...row,
        bookBalance:
          row.kind === 'credit_card'
            ? roundMoney(sub('0', register.endingBalance))
            : register.endingBalance,
        clearedBalance:
          row.kind === 'credit_card' ? roundMoney(sub('0', cleared)) : roundMoney(cleared),
        reconciledThrough: lastRecon?.endDate ?? null,
        lastStatementBalance: lastRecon ? roundMoney(lastRecon.endingBalance) : null,
      });
    }
    res.json({ items });
  }),
);

/* --------------------------------- Import --------------------------------- */

const MappingSchema = z
  .object({
    dateColumn: z.number().int().min(0).max(100),
    descriptionColumn: z.number().int().min(0).max(100),
    referenceColumn: z.number().int().min(0).max(100).optional().nullable(),
    amountColumn: z.number().int().min(0).max(100).optional().nullable(),
    debitColumn: z.number().int().min(0).max(100).optional().nullable(),
    creditColumn: z.number().int().min(0).max(100).optional().nullable(),
    dateFormat: z.enum(['MDY', 'DMY', 'YMD']),
    hasHeader: z.boolean(),
    positiveIsMoneyIn: z.boolean().optional(),
  })
  .refine((m) => m.amountColumn != null || m.debitColumn != null || m.creditColumn != null, {
    message: 'Map an amount column (or debit/credit columns)',
  });

const ImportSchema = z.object({
  accountId: z.string().uuid(),
  filename: z.string().min(1).max(200),
  content: z.string().min(1).max(2_000_000),
  mapping: MappingSchema,
  dryRun: z.boolean(),
  idempotencyKey: IdemKey,
});

bankingRouter.post(
  '/banking/import',
  requirePermission('banking.create'),
  importLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, ImportSchema);
    const result = await importBankCsv(getDb(), ctx, body, req.correlationId);
    res.status(body.dryRun ? 200 : 201).json(result);
  }),
);

bankingRouter.get(
  '/banking/imports',
  requirePermission('banking.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select()
      .from(bankImportBatches)
      .where(eq(bankImportBatches.organizationId, ctx.organizationId))
      .orderBy(desc(bankImportBatches.createdAt))
      .limit(100);
    res.json({ items: rows });
  }),
);

/* --------------------------------- Review --------------------------------- */

bankingRouter.get(
  '/banking/items',
  requirePermission('banking.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(
      req,
      PageQuery.extend({
        accountId: z.string().uuid().optional(),
        state: z
          .enum([
            'new',
            'suggested',
            'matched',
            'added',
            'excluded',
            'needs_info',
            'possible_duplicate',
            'for_review',
          ])
          .optional(),
      }),
    );
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const db = getDb();
    const conditions = [eq(bankFeedItems.organizationId, ctx.organizationId)];
    if (query.accountId) conditions.push(eq(bankFeedItems.accountId, query.accountId));
    if (query.state === 'for_review') {
      conditions.push(
        inArray(bankFeedItems.state, ['new', 'suggested', 'possible_duplicate', 'needs_info']),
      );
    } else if (query.state) {
      conditions.push(eq(bankFeedItems.state, query.state));
    }
    if (after) {
      conditions.push(
        sql`(${bankFeedItems.txnDate}, ${bankFeedItems.id}) < (${after[0]}::date, ${after[1]}::uuid)`,
      );
    }
    const rows = await db
      .select()
      .from(bankFeedItems)
      .where(and(...conditions))
      .orderBy(desc(bankFeedItems.txnDate), desc(bankFeedItems.id))
      .limit(query.limit + 1);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(rows, query.limit, (r) => [r.txnDate, r.id]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({ ...r, amount: roundMoney(r.amount) })),
    });
  }),
);

bankingRouter.get(
  '/banking/items/:id/suggestions',
  requirePermission('banking.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    res.json({ items: await suggestMatches(getDb(), ctx, id) });
  }),
);

bankingRouter.post(
  '/banking/items/:id/match',
  requirePermission('banking.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ journalEntryId: z.string().uuid() }));
    await matchFeedItem(getDb(), ctx, id, body.journalEntryId, req.correlationId);
    res.json({ ok: true });
  }),
);

bankingRouter.post(
  '/banking/items/:id/add',
  requirePermission('banking.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        splits: z
          .array(
            z.object({
              accountId: z.string().uuid(),
              amount: PositiveMoney,
              memo: z.string().max(500).optional(),
            }),
          )
          .min(1)
          .max(50),
        payeeName: z.string().max(200).optional(),
        idempotencyKey: IdemKey,
      }),
    );
    const result = await addFromFeedItem(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

bankingRouter.post(
  '/banking/items/:id/transfer',
  requirePermission('banking.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ otherAccountId: z.string().uuid(), idempotencyKey: IdemKey }),
    );
    const result = await recordTransfer(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

bankingRouter.post(
  '/banking/items/:id/state',
  requirePermission('banking.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ state: z.enum(['excluded', 'new', 'needs_info']) }));
    await setFeedItemState(getDb(), ctx, id, body.state, req.correlationId);
    res.json({ ok: true });
  }),
);

/* ---------------------------------- Rules --------------------------------- */

const RuleSchema = z.object({
  name: z.string().min(1).max(120),
  priority: z.number().int().min(1).max(10000).default(100),
  active: z.boolean().default(true),
  conditions: z.object({
    direction: z.enum(['in', 'out', 'any']),
    matchType: z.enum(['all', 'any']),
    tests: z
      .array(
        z.object({
          field: z.enum(['description', 'reference', 'amount']),
          op: z.enum(['contains', 'equals', 'starts_with']),
          value: z.string().min(1).max(200),
        }),
      )
      .min(1)
      .max(10),
  }),
  actions: z.object({
    categoryAccountId: z.string().uuid(),
    payeeName: z.string().max(200).optional(),
    memo: z.string().max(500).optional(),
  }),
  /** Auto-add is deliberately opt-in and carries a visible risk explanation. */
  autoAdd: z.boolean().default(false),
});

bankingRouter.get(
  '/banking/rules',
  requirePermission('banking.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select()
      .from(bankRules)
      .where(eq(bankRules.organizationId, ctx.organizationId))
      .orderBy(asc(bankRules.priority));
    res.json({ items: rows });
  }),
);

bankingRouter.post(
  '/banking/rules',
  requirePermission('banking.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, RuleSchema);
    const db = getDb();
    const [row] = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(bankRules)
        .values({ ...body, organizationId: ctx.organizationId, createdByUserId: ctx.userId })
        .returning();
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'bank_rule.created',
        entityType: 'bank_rule',
        entityId: inserted[0]!.id,
        payload: { name: body.name, autoAdd: body.autoAdd },
        correlationId: req.correlationId,
      });
      return inserted;
    });
    res.status(201).json(row);
  }),
);

bankingRouter.patch(
  '/banking/rules/:id',
  requirePermission('banking.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, RuleSchema.partial());
    const db = getDb();
    const updated = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(bankRules)
        .where(and(eq(bankRules.id, id), eq(bankRules.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!existing) throw AppError.notFound('Rule not found');
      const rows = await tx
        .update(bankRules)
        .set({ ...body, version: existing.version + 1, updatedAt: new Date() })
        .where(eq(bankRules.id, id))
        .returning();
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'bank_rule.updated',
        entityType: 'bank_rule',
        entityId: id,
        payload: { fields: Object.keys(body) },
        correlationId: req.correlationId,
      });
      return rows;
    });
    res.json(updated[0]);
  }),
);

/* ------------------------------ Reconciliation ---------------------------- */

const StartReconSchema = z.object({
  accountId: z.string().uuid(),
  statementStartDate: DateString,
  statementEndDate: DateString,
  beginningBalance: MoneyString,
  endingBalance: MoneyString,
});

bankingRouter.get(
  '/reconciliations',
  requirePermission('reconciliations.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select({
        id: reconciliations.id,
        accountId: reconciliations.accountId,
        accountName: accounts.name,
        statementStartDate: reconciliations.statementStartDate,
        statementEndDate: reconciliations.statementEndDate,
        beginningBalance: reconciliations.beginningBalance,
        endingBalance: reconciliations.endingBalance,
        status: reconciliations.status,
        completedAt: reconciliations.completedAt,
        hasDiscrepancy: reconciliations.hasDiscrepancy,
      })
      .from(reconciliations)
      .innerJoin(accounts, eq(reconciliations.accountId, accounts.id))
      .where(eq(reconciliations.organizationId, ctx.organizationId))
      .orderBy(desc(reconciliations.statementEndDate))
      .limit(200);
    const { roundMoney } = await import('@shared/money');
    res.json({
      items: rows.map((r) => ({
        ...r,
        beginningBalance: roundMoney(r.beginningBalance),
        endingBalance: roundMoney(r.endingBalance),
      })),
    });
  }),
);

bankingRouter.post(
  '/reconciliations',
  requirePermission('reconciliations.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, StartReconSchema);
    const result = await startReconciliation(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

bankingRouter.get(
  '/reconciliations/:id',
  requirePermission('reconciliations.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const status = await reconciliationStatus(db, ctx, id);
    // Candidate lines: everything in the account through the statement end
    // that is not already claimed by another completed reconciliation.
    const register = await accountRegister(
      db,
      ctx.organizationId,
      status.reconciliation.accountId,
      {
        endDate: status.reconciliation.statementEndDate,
        limit: 1000,
      },
    );
    const selectable = register.rows.filter(
      (r) => !r.reconciliationId || status.selectedLineIds.includes(r.lineId),
    );
    res.json({ ...status, candidateLines: selectable });
  }),
);

bankingRouter.post(
  '/reconciliations/:id/toggle',
  requirePermission('reconciliations.reconcile'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ journalLineId: z.string().uuid(), selected: z.boolean() }),
    );
    await toggleReconciliationItem(getDb(), ctx, id, body.journalLineId, body.selected);
    res.json(await reconciliationStatus(getDb(), ctx, id));
  }),
);

bankingRouter.post(
  '/reconciliations/:id/complete',
  requirePermission('reconciliations.reconcile'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ idempotencyKey: IdemKey }));
    const result = await completeReconciliation(
      getDb(),
      ctx,
      id,
      body.idempotencyKey,
      req.correlationId,
    );
    res.json(result);
  }),
);

bankingRouter.delete(
  '/reconciliations/:id',
  requirePermission('reconciliations.reconcile'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    await abandonReconciliation(getDb(), ctx, id);
    res.json({ ok: true });
  }),
);
