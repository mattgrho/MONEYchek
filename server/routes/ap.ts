import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  billLines,
  billPaymentAllocations,
  billPayments,
  bills,
  companyProfiles,
  expenseLines,
  expenses,
  vendors,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { companyToday } from '../lib/dates';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  applyVendorCredit,
  billOpenBalance,
  createAndPostExpense,
  createBillDraft,
  createVendorCreditDraft,
  decideBillApproval,
  payBills,
  postBill,
  postVendorCredit,
  voidBill,
  voidExpense,
} from '../services/bills';
import { apAging, apControlBalance } from '../reports/ap';

export const apRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IdemKey = z.string().min(8).max(200);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });

/* --------------------------------- Vendors ------------------------------- */

const VendorSchema = z.object({
  displayName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional().nullable(),
  contactName: z.string().max(200).optional().nullable(),
  email: z
    .string()
    .email()
    .optional()
    .nullable()
    .or(z.literal('').transform(() => null)),
  phone: z.string().max(40).optional().nullable(),
  termsDays: z.number().int().min(0).max(365).optional().nullable(),
  is1099Eligible: z.boolean().optional(),
  defaultExpenseAccountId: z.string().uuid().optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  active: z.boolean().optional(),
});

apRouter.get(
  '/vendors',
  requirePermission('vendors.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, z.object({ includeInactive: z.coerce.boolean().optional() }));
    const rows = await getDb()
      .select()
      .from(vendors)
      .where(eq(vendors.organizationId, ctx.organizationId))
      .orderBy(asc(vendors.displayName))
      .limit(5000);
    res.json({ items: rows.filter((r) => query.includeInactive || r.active) });
  }),
);

apRouter.post(
  '/vendors',
  requirePermission('vendors.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, VendorSchema);
    const [row] = await getDb()
      .insert(vendors)
      .values({ ...body, organizationId: ctx.organizationId })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict('DUPLICATE_VENDOR', 'A vendor with this name already exists');
        }
        throw err;
      });
    res.status(201).json(row);
  }),
);

apRouter.patch(
  '/vendors/:id',
  requirePermission('vendors.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, VendorSchema.partial());
    const updated = await getDb()
      .update(vendors)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(vendors.id, id), eq(vendors.organizationId, ctx.organizationId)))
      .returning();
    if (!updated[0]) throw AppError.notFound('Vendor not found');
    res.json(updated[0]);
  }),
);

/* ---------------------------------- Bills -------------------------------- */

const BillLineSchema = z
  .object({
    accountId: z.string().uuid().optional().nullable(),
    productId: z.string().uuid().optional().nullable(),
    description: z.string().max(1000).optional(),
    quantity: MoneyString.optional().nullable(),
    unitCost: MoneyString.optional().nullable(),
    amount: MoneyString.optional().nullable(),
    billableCustomerId: z.string().uuid().optional().nullable(),
  })
  .refine((l) => l.accountId || l.productId, { message: 'Each line needs an account or product' });

const BillSchema = z.object({
  vendorId: z.string().uuid(),
  billDate: DateString,
  dueDate: DateString.optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  vendorReference: z.string().max(80).optional(),
  memo: z.string().max(2000).optional(),
  lines: z.array(BillLineSchema).min(1).max(200),
});

apRouter.get(
  '/bills',
  requirePermission('bills.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const result = await getDb().execute(sql`
      SELECT b.id, b.number, b.vendor_id, v.display_name AS vendor_name,
             b.posting_status, b.approval_status, b.bill_date::text AS bill_date,
             b.due_date::text AS due_date, b.vendor_reference, b.total::text,
             (b.total
               - COALESCE((SELECT SUM(pa.amount) FROM bill_payment_allocations pa
                           WHERE pa.bill_id = b.id), 0)
               - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                           WHERE va.bill_id = b.id), 0)
             )::text AS open_balance
      FROM bills b
      JOIN vendors v ON v.id = b.vendor_id
      WHERE b.organization_id = ${ctx.organizationId}
        ${after ? sql`AND (b.bill_date, b.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY b.bill_date DESC, b.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney, cmp } = await import('@shared/money');
    interface Row {
      id: string;
      number: string;
      vendor_id: string;
      vendor_name: string;
      posting_status: string;
      approval_status: string;
      bill_date: string;
      due_date: string;
      vendor_reference: string | null;
      total: string;
      open_balance: string;
    }
    const page = pageResult(result.rows as unknown as Row[], query.limit, (r) => [
      r.bill_date,
      r.number,
    ]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => {
        const open = r.posting_status === 'posted' ? roundMoney(r.open_balance) : '0.00';
        return {
          id: r.id,
          number: r.number,
          vendorId: r.vendor_id,
          vendorName: r.vendor_name,
          postingStatus: r.posting_status,
          approvalStatus: r.approval_status,
          billDate: r.bill_date,
          dueDate: r.due_date,
          vendorReference: r.vendor_reference,
          total: roundMoney(r.total),
          openBalance: open,
          settlementStatus:
            r.posting_status !== 'posted'
              ? null
              : cmp(open, '0') <= 0
                ? 'paid'
                : cmp(open, r.total) < 0
                  ? 'partially_paid'
                  : 'open',
        };
      }),
    });
  }),
);

apRouter.get(
  '/bills/:id',
  requirePermission('bills.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [bill] = await db
      .select()
      .from(bills)
      .where(and(eq(bills.id, id), eq(bills.organizationId, ctx.organizationId)))
      .limit(1);
    if (!bill) throw AppError.notFound('Bill not found');
    const lines = await db
      .select()
      .from(billLines)
      .where(eq(billLines.billId, id))
      .orderBy(asc(billLines.lineNumber));
    const allocations = await db
      .select({
        id: billPaymentAllocations.id,
        billPaymentId: billPaymentAllocations.billPaymentId,
        paymentNumber: billPayments.number,
        amount: billPaymentAllocations.amount,
        effectiveDate: billPaymentAllocations.effectiveDate,
      })
      .from(billPaymentAllocations)
      .innerJoin(billPayments, eq(billPaymentAllocations.billPaymentId, billPayments.id))
      .where(eq(billPaymentAllocations.billId, id));
    const { roundMoney } = await import('@shared/money');
    const openBalance =
      bill.postingStatus === 'posted'
        ? await db.transaction((tx) => billOpenBalance(tx, id))
        : '0.00';
    res.json({
      ...bill,
      total: roundMoney(bill.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
      paymentAllocations: allocations.map((a) => ({ ...a, amount: roundMoney(a.amount) })),
      openBalance,
    });
  }),
);

apRouter.post(
  '/bills',
  requirePermission('bills.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, BillSchema);
    const result = await createBillDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

apRouter.post(
  '/bills/:id/approve',
  requirePermission('bills.approve'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    await decideBillApproval(getDb(), ctx, id, { decision: 'approved' }, req.correlationId);
    res.json({ ok: true });
  }),
);

apRouter.post(
  '/bills/:id/reject',
  requirePermission('bills.approve'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ reason: z.string().min(3).max(500) }));
    await decideBillApproval(
      getDb(),
      ctx,
      id,
      { decision: 'rejected', reason: body.reason },
      req.correlationId,
    );
    res.json({ ok: true });
  }),
);

apRouter.post(
  '/bills/:id/post',
  requirePermission('bills.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ idempotencyKey: IdemKey }));
    const result = await postBill(getDb(), ctx, id, body.idempotencyKey, req.correlationId);
    res.json(result);
  }),
);

apRouter.post(
  '/bills/:id/void',
  requirePermission('bills.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ idempotencyKey: IdemKey, reason: z.string().min(3).max(500) }),
    );
    const result = await voidBill(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

/* --------------------------------- Expenses ------------------------------ */

apRouter.get(
  '/expenses',
  requirePermission('expenses.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const db = getDb();
    const conditions = [eq(expenses.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${expenses.expenseDate}, ${expenses.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await db
      .select({
        id: expenses.id,
        number: expenses.number,
        vendorId: expenses.vendorId,
        vendorName: vendors.displayName,
        payeeName: expenses.payeeName,
        postingStatus: expenses.postingStatus,
        expenseDate: expenses.expenseDate,
        method: expenses.method,
        reference: expenses.reference,
        total: expenses.total,
        paymentAccountId: expenses.paymentAccountId,
      })
      .from(expenses)
      .leftJoin(vendors, eq(expenses.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(desc(expenses.expenseDate), desc(expenses.number))
      .limit(query.limit + 1);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(rows, query.limit, (r) => [r.expenseDate, r.number]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({ ...r, total: roundMoney(r.total) })),
    });
  }),
);

apRouter.get(
  '/expenses/:id',
  requirePermission('expenses.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [expense] = await db
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, id), eq(expenses.organizationId, ctx.organizationId)))
      .limit(1);
    if (!expense) throw AppError.notFound('Expense not found');
    const lines = await db
      .select()
      .from(expenseLines)
      .where(eq(expenseLines.expenseId, id))
      .orderBy(asc(expenseLines.lineNumber));
    const { roundMoney } = await import('@shared/money');
    res.json({
      ...expense,
      total: roundMoney(expense.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
    });
  }),
);

const ExpenseSchema = z.object({
  vendorId: z.string().uuid().optional().nullable(),
  payeeName: z.string().max(200).optional().nullable(),
  expenseDate: DateString,
  paymentAccountId: z.string().uuid(),
  method: z.enum(['check', 'card', 'cash', 'ach', 'other']),
  reference: z.string().max(80).optional(),
  memo: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        description: z.string().max(1000).optional(),
        amount: MoneyString,
        billableCustomerId: z.string().uuid().optional().nullable(),
      }),
    )
    .min(1)
    .max(200),
  idempotencyKey: IdemKey,
});

apRouter.post(
  '/expenses',
  requirePermission('expenses.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, ExpenseSchema);
    const result = await createAndPostExpense(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

apRouter.post(
  '/expenses/:id/void',
  requirePermission('expenses.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ idempotencyKey: IdemKey, reason: z.string().min(3).max(500) }),
    );
    const result = await voidExpense(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

/* ------------------------------ Vendor credits ---------------------------- */

apRouter.get(
  '/vendor-credits',
  requirePermission('vendor_credits.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const result = await getDb().execute(sql`
      SELECT c.id, c.number, c.vendor_id, v.display_name AS vendor_name,
             c.posting_status, c.credit_date::text AS credit_date, c.total::text,
             (c.total
               - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                           WHERE va.vendor_credit_id = c.id), 0)
             )::text AS unapplied
      FROM vendor_credits c
      JOIN vendors v ON v.id = c.vendor_id
      WHERE c.organization_id = ${ctx.organizationId}
        ${after ? sql`AND (c.credit_date, c.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY c.credit_date DESC, c.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney } = await import('@shared/money');
    interface Row {
      id: string;
      number: string;
      vendor_id: string;
      vendor_name: string;
      posting_status: string;
      credit_date: string;
      total: string;
      unapplied: string;
    }
    const page = pageResult(result.rows as unknown as Row[], query.limit, (r) => [
      r.credit_date,
      r.number,
    ]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        number: r.number,
        vendorId: r.vendor_id,
        vendorName: r.vendor_name,
        postingStatus: r.posting_status,
        creditDate: r.credit_date,
        total: roundMoney(r.total),
        unapplied: r.posting_status === 'posted' ? roundMoney(r.unapplied) : '0.00',
      })),
    });
  }),
);

const VendorCreditSchema = z.object({
  vendorId: z.string().uuid(),
  creditDate: DateString,
  memo: z.string().max(2000).optional(),
  lines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        description: z.string().max(1000).optional(),
        amount: MoneyString,
      }),
    )
    .min(1)
    .max(200),
});

apRouter.post(
  '/vendor-credits',
  requirePermission('vendor_credits.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, VendorCreditSchema);
    const result = await createVendorCreditDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

apRouter.post(
  '/vendor-credits/:id/post',
  requirePermission('vendor_credits.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ idempotencyKey: IdemKey }));
    const result = await postVendorCredit(getDb(), ctx, id, body.idempotencyKey, req.correlationId);
    res.json(result);
  }),
);

apRouter.post(
  '/vendor-credits/:id/apply',
  requirePermission('vendor_credits.edit'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        allocations: z.array(z.object({ billId: z.string().uuid(), amount: MoneyString })).min(1),
        effectiveDate: DateString,
        idempotencyKey: IdemKey,
      }),
    );
    await applyVendorCredit(getDb(), ctx, id, body);
    res.json({ ok: true });
  }),
);

/* ------------------------------ Bill payments ----------------------------- */

apRouter.get(
  '/bill-payments',
  requirePermission('bill_payments.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const db = getDb();
    const conditions = [eq(billPayments.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${billPayments.paymentDate}, ${billPayments.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await db
      .select({
        id: billPayments.id,
        number: billPayments.number,
        vendorId: billPayments.vendorId,
        vendorName: vendors.displayName,
        postingStatus: billPayments.postingStatus,
        paymentDate: billPayments.paymentDate,
        method: billPayments.method,
        reference: billPayments.reference,
        amount: billPayments.amount,
      })
      .from(billPayments)
      .innerJoin(vendors, eq(billPayments.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(desc(billPayments.paymentDate), desc(billPayments.number))
      .limit(query.limit + 1);
    const page = pageResult(rows, query.limit, (r) => [r.paymentDate, r.number]);
    const pageIds = page.items.map((r) => r.id);
    const allocations = pageIds.length
      ? await db
          .select({
            billPaymentId: billPaymentAllocations.billPaymentId,
            billId: billPaymentAllocations.billId,
            billNumber: bills.number,
            amount: billPaymentAllocations.amount,
          })
          .from(billPaymentAllocations)
          .innerJoin(bills, eq(billPaymentAllocations.billId, bills.id))
          .where(
            and(
              eq(billPaymentAllocations.organizationId, ctx.organizationId),
              sql`${billPaymentAllocations.billPaymentId} IN (${sql.join(
                pageIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          )
      : [];
    const { roundMoney } = await import('@shared/money');
    const byPayment = new Map<string, { billId: string; billNumber: string; amount: string }[]>();
    for (const a of allocations) {
      const list = byPayment.get(a.billPaymentId) ?? [];
      list.push({ billId: a.billId, billNumber: a.billNumber, amount: roundMoney(a.amount) });
      byPayment.set(a.billPaymentId, list);
    }
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        ...r,
        amount: roundMoney(r.amount),
        allocations: byPayment.get(r.id) ?? [],
      })),
    });
  }),
);

const PayBillsSchema = z.object({
  vendorId: z.string().uuid(),
  paymentDate: DateString,
  bankAccountId: z.string().uuid(),
  method: z.string().max(40).optional(),
  reference: z.string().max(80).optional(),
  memo: z.string().max(2000).optional(),
  allocations: z.array(z.object({ billId: z.string().uuid(), amount: MoneyString })).min(1),
  idempotencyKey: IdemKey,
});

apRouter.post(
  '/bill-payments',
  requirePermission('bill_payments.pay'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, PayBillsSchema);
    const result = await payBills(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* -------------------------------- AP reports ------------------------------ */

apRouter.get(
  '/reports/ap-aging',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();
    const [profile] = await db
      .select({ timeZone: companyProfiles.timeZone })
      .from(companyProfiles)
      .where(eq(companyProfiles.organizationId, ctx.organizationId))
      .limit(1);
    const query = parseQuery(req, z.object({ asOf: DateString.optional() }));
    const asOf = query.asOf ?? companyToday(profile?.timeZone ?? 'America/New_York');
    const aging = await apAging(db, ctx.organizationId, asOf);
    const controlBalance = await apControlBalance(db, ctx.organizationId, asOf);
    res.json({ ...aging, controlBalance, tiesToControl: aging.total === controlBalance });
  }),
);
