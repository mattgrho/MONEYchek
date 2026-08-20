import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  companyProfiles,
  creditAllocations,
  creditMemoLines,
  creditMemos,
  customerPaymentAllocations,
  customerPayments,
  customers,
  depositComponents,
  deposits,
  invoiceLines,
  invoices,
  salesReceipts,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { companyToday } from '../lib/dates';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  createAndPostSalesReceipt,
  createCreditMemoDraft,
  createInvoiceDraft,
  invoiceOpenBalance,
  postCreditMemo,
  postInvoice,
  updateInvoiceDraft,
  voidInvoice,
  writeOffInvoice,
} from '../services/invoices';
import {
  applyCreditMemo,
  applyPayment,
  createDeposit,
  listUndepositedReceipts,
  receiveCustomerPayment,
  refundCustomerCredit,
  unapplyPaymentAllocation,
  voidCustomerPayment,
} from '../services/payments';
import { arAging, arControlBalance } from '../reports/ar';

export const arRouter = Router();

interface ArListRow {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  posting_status: string;
  invoice_date: string;
  due_date: string;
  subtotal: string;
  tax_total: string;
  total: string;
  open_balance: string;
}
interface PaymentListRow {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  posting_status: string;
  payment_date: string;
  method: string | null;
  reference: string | null;
  amount: string;
  deposit_to_name: string;
  returned_date: string | null;
  unapplied: string;
}
interface CreditListRow {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  posting_status: string;
  credit_date: string;
  total: string;
  unapplied: string;
}

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IdemKey = z.string().min(8).max(200);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });

const SalesLineSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  description: z.string().max(1000).optional(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  taxable: z.boolean().optional(),
  incomeAccountId: z.string().uuid().optional().nullable(),
});

/* --------------------------------- Invoices ------------------------------ */

arRouter.get(
  '/invoices',
  requirePermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery.extend({ customerId: z.string().uuid().optional() }));
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const db = getDb();
    const result = await db.execute(sql`
      SELECT i.id, i.number, i.customer_id, c.display_name AS customer_name,
             i.posting_status, i.invoice_date::text AS invoice_date,
             i.due_date::text AS due_date, i.subtotal::text, i.tax_total::text,
             i.total::text,
             (i.total
               - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                           WHERE pa.invoice_id = i.id), 0)
               - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                           WHERE ca.invoice_id = i.id), 0)
               - COALESCE((SELECT SUM(w.amount) FROM invoice_write_offs w
                           WHERE w.invoice_id = i.id AND w.reversal_of_write_off_id IS NULL), 0)
               - COALESCE((SELECT SUM(ra.amount) FROM retainer_applications ra
                           WHERE ra.invoice_id = i.id), 0)
             )::text AS open_balance
      FROM invoices i
      JOIN customers c ON c.id = i.customer_id
      WHERE i.organization_id = ${ctx.organizationId}
        ${query.customerId ? sql`AND i.customer_id = ${query.customerId}` : sql``}
        ${after ? sql`AND (i.invoice_date, i.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY i.invoice_date DESC, i.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney, cmp } = await import('@shared/money');
    const page = pageResult(result.rows as unknown as ArListRow[], query.limit, (r) => [
      r.invoice_date,
      r.number,
    ]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => {
        const open = r.posting_status === 'posted' ? roundMoney(r.open_balance) : '0.00';
        return {
          id: r.id,
          number: r.number,
          customerId: r.customer_id,
          customerName: r.customer_name,
          postingStatus: r.posting_status,
          invoiceDate: r.invoice_date,
          dueDate: r.due_date,
          subtotal: roundMoney(r.subtotal),
          taxTotal: roundMoney(r.tax_total),
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

arRouter.get(
  '/invoices/:id',
  requirePermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.organizationId, ctx.organizationId)))
      .limit(1);
    if (!invoice) throw AppError.notFound('Invoice not found');
    const lines = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, id))
      .orderBy(asc(invoiceLines.lineNumber));
    const allocations = await db
      .select({
        id: customerPaymentAllocations.id,
        paymentId: customerPaymentAllocations.paymentId,
        paymentNumber: customerPayments.number,
        amount: customerPaymentAllocations.amount,
        effectiveDate: customerPaymentAllocations.effectiveDate,
        reversalOfAllocationId: customerPaymentAllocations.reversalOfAllocationId,
      })
      .from(customerPaymentAllocations)
      .innerJoin(customerPayments, eq(customerPaymentAllocations.paymentId, customerPayments.id))
      .where(eq(customerPaymentAllocations.invoiceId, id))
      .orderBy(asc(customerPaymentAllocations.createdAt));
    const credits = await db
      .select({
        id: creditAllocations.id,
        creditMemoId: creditAllocations.creditMemoId,
        creditNumber: creditMemos.number,
        amount: creditAllocations.amount,
        effectiveDate: creditAllocations.effectiveDate,
      })
      .from(creditAllocations)
      .innerJoin(creditMemos, eq(creditAllocations.creditMemoId, creditMemos.id))
      .where(eq(creditAllocations.invoiceId, id));
    const openBalance =
      invoice.postingStatus === 'posted'
        ? await db.transaction((tx) => invoiceOpenBalance(tx, id))
        : '0.00';
    const { roundMoney, cmp: cmpMoney } = await import('@shared/money');
    res.json({
      ...invoice,
      subtotal: roundMoney(invoice.subtotal),
      taxTotal: roundMoney(invoice.taxTotal),
      total: roundMoney(invoice.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
      paymentAllocations: allocations.map((a) => ({ ...a, amount: roundMoney(a.amount) })),
      creditAllocations: credits.map((c) => ({ ...c, amount: roundMoney(c.amount) })),
      openBalance,
      settlementStatus:
        invoice.postingStatus !== 'posted'
          ? null
          : cmpMoney(openBalance, '0') <= 0
            ? 'paid'
            : cmpMoney(openBalance, invoice.total) < 0
              ? 'partially_paid'
              : 'open',
    });
  }),
);

const InvoiceSchema = z.object({
  customerId: z.string().uuid(),
  invoiceDate: DateString,
  dueDate: DateString.optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  memo: z.string().max(2000).optional(),
  customerMessage: z.string().max(2000).optional(),
  taxRateId: z.string().uuid().optional().nullable(),
  estimateId: z.string().uuid().optional().nullable(),
  lines: z.array(SalesLineSchema).min(1).max(200),
});

arRouter.post(
  '/invoices',
  requirePermission('invoices.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, InvoiceSchema);
    const result = await createInvoiceDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

arRouter.patch(
  '/invoices/:id',
  requirePermission('invoices.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, InvoiceSchema.partial());
    await updateInvoiceDraft(getDb(), ctx, id, body);
    res.json({ ok: true });
  }),
);

arRouter.post(
  '/invoices/:id/post',
  requirePermission('invoices.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ idempotencyKey: IdemKey }));
    const result = await postInvoice(getDb(), ctx, id, body.idempotencyKey, req.correlationId);
    res.json(result);
  }),
);

arRouter.post(
  '/invoices/:id/void',
  requirePermission('invoices.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        idempotencyKey: IdemKey,
        reason: z.string().min(3).max(500),
        confirmInventoryReturn: z.boolean().optional(),
      }),
    );
    const result = await voidInvoice(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

arRouter.post(
  '/invoices/:id/write-off',
  requirePermission('invoices.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        idempotencyKey: IdemKey,
        amount: MoneyString,
        date: DateString,
        reason: z.string().min(3).max(500),
      }),
    );
    const result = await writeOffInvoice(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

/* --------------------------------- Payments ------------------------------ */

arRouter.get(
  '/payments',
  requirePermission('customer_payments.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const result = await getDb().execute(sql`
      SELECT p.id, p.number, p.customer_id, c.display_name AS customer_name,
             p.posting_status, p.payment_date::text AS payment_date, p.method,
             p.reference, p.amount::text, a.name AS deposit_to_name,
             p.returned_date::text AS returned_date,
             (p.amount
               - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                           WHERE pa.payment_id = p.id), 0)
               - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                           WHERE r.source_type = 'payment' AND r.source_id = p.id), 0)
               - CASE WHEN p.returned_date IS NOT NULL THEN p.amount ELSE 0 END
             )::text AS unapplied
      FROM customer_payments p
      JOIN customers c ON c.id = p.customer_id
      JOIN accounts a ON a.id = p.deposit_to_account_id
      WHERE p.organization_id = ${ctx.organizationId}
        ${after ? sql`AND (p.payment_date, p.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY p.payment_date DESC, p.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(result.rows as unknown as PaymentListRow[], query.limit, (r) => [
      r.payment_date,
      r.number,
    ]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        number: r.number,
        customerId: r.customer_id,
        customerName: r.customer_name,
        postingStatus: r.posting_status,
        paymentDate: r.payment_date,
        method: r.method,
        reference: r.reference,
        amount: roundMoney(r.amount),
        depositToName: r.deposit_to_name,
        returnedDate: r.returned_date,
        unapplied: r.posting_status === 'posted' ? roundMoney(r.unapplied) : '0.00',
      })),
    });
  }),
);

arRouter.get(
  '/payments/:id',
  requirePermission('customer_payments.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [payment] = await db
      .select()
      .from(customerPayments)
      .where(
        and(eq(customerPayments.id, id), eq(customerPayments.organizationId, ctx.organizationId)),
      )
      .limit(1);
    if (!payment) throw AppError.notFound('Payment not found');
    const allocations = await db
      .select({
        id: customerPaymentAllocations.id,
        invoiceId: customerPaymentAllocations.invoiceId,
        invoiceNumber: invoices.number,
        amount: customerPaymentAllocations.amount,
        effectiveDate: customerPaymentAllocations.effectiveDate,
        reversalOfAllocationId: customerPaymentAllocations.reversalOfAllocationId,
      })
      .from(customerPaymentAllocations)
      .innerJoin(invoices, eq(customerPaymentAllocations.invoiceId, invoices.id))
      .where(eq(customerPaymentAllocations.paymentId, id))
      .orderBy(asc(customerPaymentAllocations.createdAt));
    res.json({ ...payment, allocations });
  }),
);

const ReceivePaymentSchema = z.object({
  customerId: z.string().uuid(),
  paymentDate: DateString,
  amount: MoneyString,
  depositToAccountId: z.string().uuid(),
  method: z.string().max(40).optional(),
  reference: z.string().max(80).optional(),
  memo: z.string().max(2000).optional(),
  allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: MoneyString })).optional(),
  autoApply: z.boolean().optional(),
  idempotencyKey: IdemKey,
});

arRouter.post(
  '/payments',
  requirePermission('customer_payments.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, ReceivePaymentSchema);
    const result = await receiveCustomerPayment(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

arRouter.post(
  '/payments/:id/apply',
  requirePermission('customer_payments.edit'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        allocations: z
          .array(z.object({ invoiceId: z.string().uuid(), amount: MoneyString }))
          .min(1),
        effectiveDate: DateString,
        idempotencyKey: IdemKey,
      }),
    );
    await applyPayment(getDb(), ctx, id, body, req.correlationId);
    res.json({ ok: true });
  }),
);

arRouter.post(
  '/payment-allocations/:id/unapply',
  requirePermission('customer_payments.edit'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ effectiveDate: DateString, idempotencyKey: IdemKey }));
    await unapplyPaymentAllocation(getDb(), ctx, id, body, req.correlationId);
    res.json({ ok: true });
  }),
);

arRouter.post(
  '/payments/:id/return',
  requirePermission('customer_payments.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        returnDate: DateString,
        reason: z.string().min(3).max(500),
        idempotencyKey: IdemKey,
      }),
    );
    const { returnCustomerPayment } = await import('../services/payments');
    const result = await returnCustomerPayment(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

arRouter.post(
  '/payments/:id/void',
  requirePermission('customer_payments.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ idempotencyKey: IdemKey, reason: z.string().min(3).max(500) }),
    );
    const result = await voidCustomerPayment(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

/* ------------------------------- Credit memos ---------------------------- */

arRouter.get(
  '/credit-memos',
  requirePermission('credit_memos.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const result = await getDb().execute(sql`
      SELECT m.id, m.number, m.customer_id, c.display_name AS customer_name,
             m.posting_status, m.credit_date::text AS credit_date, m.total::text,
             (m.total
               - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                           WHERE ca.credit_memo_id = m.id), 0)
               - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                           WHERE r.source_type = 'credit_memo' AND r.source_id = m.id), 0)
             )::text AS unapplied
      FROM credit_memos m
      JOIN customers c ON c.id = m.customer_id
      WHERE m.organization_id = ${ctx.organizationId}
        ${after ? sql`AND (m.credit_date, m.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY m.credit_date DESC, m.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(result.rows as unknown as CreditListRow[], query.limit, (r) => [
      r.credit_date,
      r.number,
    ]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        id: r.id,
        number: r.number,
        customerId: r.customer_id,
        customerName: r.customer_name,
        postingStatus: r.posting_status,
        creditDate: r.credit_date,
        total: roundMoney(r.total),
        unapplied: r.posting_status === 'posted' ? roundMoney(r.unapplied) : '0.00',
      })),
    });
  }),
);

arRouter.get(
  '/credit-memos/:id',
  requirePermission('credit_memos.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [credit] = await db
      .select()
      .from(creditMemos)
      .where(and(eq(creditMemos.id, id), eq(creditMemos.organizationId, ctx.organizationId)))
      .limit(1);
    if (!credit) throw AppError.notFound('Credit memo not found');
    const lines = await db
      .select()
      .from(creditMemoLines)
      .where(eq(creditMemoLines.creditMemoId, id))
      .orderBy(asc(creditMemoLines.lineNumber));
    const { roundMoney } = await import('@shared/money');
    res.json({
      ...credit,
      subtotal: roundMoney(credit.subtotal),
      taxTotal: roundMoney(credit.taxTotal),
      total: roundMoney(credit.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
    });
  }),
);

const CreditMemoSchema = z.object({
  customerId: z.string().uuid(),
  creditDate: DateString,
  memo: z.string().max(2000).optional(),
  taxRateId: z.string().uuid().optional().nullable(),
  lines: z.array(SalesLineSchema).min(1).max(200),
});

arRouter.post(
  '/credit-memos',
  requirePermission('credit_memos.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CreditMemoSchema);
    const result = await createCreditMemoDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

arRouter.post(
  '/credit-memos/:id/post',
  requirePermission('credit_memos.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ idempotencyKey: IdemKey }));
    const result = await postCreditMemo(getDb(), ctx, id, body.idempotencyKey, req.correlationId);
    res.json(result);
  }),
);

arRouter.post(
  '/credit-memos/:id/apply',
  requirePermission('credit_memos.edit'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        allocations: z
          .array(z.object({ invoiceId: z.string().uuid(), amount: MoneyString }))
          .min(1),
        effectiveDate: DateString,
        idempotencyKey: IdemKey,
      }),
    );
    await applyCreditMemo(getDb(), ctx, id, body, req.correlationId);
    res.json({ ok: true });
  }),
);

arRouter.post(
  '/customer-refunds',
  requirePermission('customer_payments.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(
      req,
      z.object({
        sourceType: z.enum(['credit_memo', 'payment']),
        sourceId: z.string().uuid(),
        amount: MoneyString,
        refundDate: DateString,
        bankAccountId: z.string().uuid(),
        memo: z.string().max(500).optional(),
        idempotencyKey: IdemKey,
      }),
    );
    const result = await refundCustomerCredit(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* ------------------------------ Sales receipts --------------------------- */

arRouter.get(
  '/sales-receipts',
  requirePermission('sales_receipts.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const conditions = [eq(salesReceipts.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${salesReceipts.receiptDate}, ${salesReceipts.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await getDb()
      .select({
        id: salesReceipts.id,
        number: salesReceipts.number,
        customerId: salesReceipts.customerId,
        customerName: customers.displayName,
        postingStatus: salesReceipts.postingStatus,
        receiptDate: salesReceipts.receiptDate,
        total: salesReceipts.total,
      })
      .from(salesReceipts)
      .leftJoin(customers, eq(salesReceipts.customerId, customers.id))
      .where(and(...conditions))
      .orderBy(desc(salesReceipts.receiptDate), desc(salesReceipts.number))
      .limit(query.limit + 1);
    const page = pageResult(rows, query.limit, (r) => [r.receiptDate, r.number]);
    res.json({ items: page.items, nextCursor: page.nextCursor });
  }),
);

const SalesReceiptSchema = z.object({
  customerId: z.string().uuid().optional().nullable(),
  receiptDate: DateString,
  depositToAccountId: z.string().uuid(),
  memo: z.string().max(2000).optional(),
  taxRateId: z.string().uuid().optional().nullable(),
  lines: z.array(SalesLineSchema).min(1).max(200),
  idempotencyKey: IdemKey,
});

arRouter.post(
  '/sales-receipts',
  requirePermission('sales_receipts.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, SalesReceiptSchema);
    const result = await createAndPostSalesReceipt(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* --------------------------------- Deposits ------------------------------ */

arRouter.get(
  '/undeposited-receipts',
  requirePermission('deposits.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    res.json({ items: await listUndepositedReceipts(getDb(), ctx.organizationId) });
  }),
);

arRouter.get(
  '/deposits',
  requirePermission('deposits.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const db = getDb();
    const conditions = [eq(deposits.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${deposits.depositDate}, ${deposits.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await db
      .select()
      .from(deposits)
      .where(and(...conditions))
      .orderBy(desc(deposits.depositDate), desc(deposits.number))
      .limit(query.limit + 1);
    const page = pageResult(rows, query.limit, (r) => [r.depositDate, r.number]);
    const pageIds = page.items.map((d) => d.id);
    const components = pageIds.length
      ? await db
          .select()
          .from(depositComponents)
          .where(
            and(
              eq(depositComponents.organizationId, ctx.organizationId),
              sql`${depositComponents.depositId} IN (${sql.join(
                pageIds.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            ),
          )
      : [];
    const byDeposit = new Map<string, typeof components>();
    for (const c of components) {
      const list = byDeposit.get(c.depositId) ?? [];
      list.push(c);
      byDeposit.set(c.depositId, list);
    }
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((d) => ({ ...d, components: byDeposit.get(d.id) ?? [] })),
    });
  }),
);

const DepositSchema = z.object({
  depositDate: DateString,
  bankAccountId: z.string().uuid(),
  memo: z.string().max(2000).optional(),
  receipts: z
    .array(
      z.object({
        sourceType: z.enum(['customer_payment', 'sales_receipt']),
        sourceId: z.string().uuid(),
      }),
    )
    .default([]),
  otherLines: z
    .array(
      z.object({
        accountId: z.string().uuid(),
        amount: MoneyString,
        description: z.string().max(200).optional(),
      }),
    )
    .optional(),
  idempotencyKey: IdemKey,
});

arRouter.post(
  '/deposits',
  requirePermission('deposits.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, DepositSchema);
    const result = await createDeposit(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

/* -------------------------------- AR reports ----------------------------- */

arRouter.get(
  '/reports/ar-aging',
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
    const aging = await arAging(db, ctx.organizationId, asOf);
    const controlBalance = await arControlBalance(db, ctx.organizationId, asOf);
    res.json({ ...aging, controlBalance, tiesToControl: aging.total === controlBalance });
  }),
);
