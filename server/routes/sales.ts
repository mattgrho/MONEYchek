import { Router } from 'express';
import { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  customers,
  estimateLines,
  estimates,
  productsServices,
  taxRates,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { AppError } from '../lib/errors';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  convertEstimateToInvoice,
  createEstimateDraft,
  transitionEstimate,
} from '../services/invoices';

export const salesRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* -------------------------------- Customers ------------------------------ */

const CustomerSchema = z.object({
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
  billingAddress: z.record(z.string()).optional().nullable(),
  shippingAddress: z.record(z.string()).optional().nullable(),
  termsDays: z.number().int().min(0).max(365).optional().nullable(),
  taxExempt: z.boolean().optional(),
  notes: z.string().max(4000).optional().nullable(),
  active: z.boolean().optional(),
});

salesRouter.get(
  '/customers',
  requirePermission('customers.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, z.object({ includeInactive: z.coerce.boolean().optional() }));
    const rows = await getDb()
      .select()
      .from(customers)
      .where(eq(customers.organizationId, ctx.organizationId))
      .orderBy(asc(customers.displayName))
      .limit(5000);
    res.json({ items: rows.filter((r) => query.includeInactive || r.active) });
  }),
);

salesRouter.post(
  '/customers',
  requirePermission('customers.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, CustomerSchema);
    const [row] = await getDb()
      .insert(customers)
      .values({ ...body, organizationId: ctx.organizationId })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict('DUPLICATE_CUSTOMER', 'A customer with this name already exists');
        }
        throw err;
      });
    res.status(201).json(row);
  }),
);

salesRouter.patch(
  '/customers/:id',
  requirePermission('customers.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, CustomerSchema.partial());
    const updated = await getDb()
      .update(customers)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(customers.id, id), eq(customers.organizationId, ctx.organizationId)))
      .returning();
    if (!updated[0]) throw AppError.notFound('Customer not found');
    res.json(updated[0]);
  }),
);

/* --------------------------- Products & services ------------------------- */

const ProductSchema = z.object({
  type: z.enum(['service', 'non_inventory']),
  name: z.string().min(1).max(200),
  sku: z.string().max(60).optional().nullable(),
  salesDescription: z.string().max(1000).optional().nullable(),
  purchaseDescription: z.string().max(1000).optional().nullable(),
  salesPrice: MoneyString.optional().nullable(),
  purchaseCost: MoneyString.optional().nullable(),
  incomeAccountId: z.string().uuid().optional().nullable(),
  expenseAccountId: z.string().uuid().optional().nullable(),
  taxable: z.boolean().optional(),
  unitLabel: z.string().max(20).optional().nullable(),
  active: z.boolean().optional(),
});

salesRouter.get(
  '/products',
  requirePermission('products.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, z.object({ includeInactive: z.coerce.boolean().optional() }));
    const rows = await getDb()
      .select()
      .from(productsServices)
      .where(eq(productsServices.organizationId, ctx.organizationId))
      .orderBy(asc(productsServices.name))
      .limit(5000);
    res.json({ items: rows.filter((r) => query.includeInactive || r.active) });
  }),
);

salesRouter.post(
  '/products',
  requirePermission('products.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, ProductSchema);
    const [row] = await getDb()
      .insert(productsServices)
      .values({ ...body, organizationId: ctx.organizationId })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict('DUPLICATE_PRODUCT', 'A product with this name already exists');
        }
        throw err;
      });
    res.status(201).json(row);
  }),
);

salesRouter.patch(
  '/products/:id',
  requirePermission('products.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, ProductSchema.partial().omit({ type: true }));
    const updated = await getDb()
      .update(productsServices)
      .set({ ...body, updatedAt: new Date() })
      .where(
        and(eq(productsServices.id, id), eq(productsServices.organizationId, ctx.organizationId)),
      )
      .returning();
    if (!updated[0]) throw AppError.notFound('Product not found');
    res.json(updated[0]);
  }),
);

/* -------------------------------- Tax rates ------------------------------ */

const TaxRateSchema = z.object({
  name: z.string().min(1).max(120),
  agencyName: z.string().max(200).optional(),
  /** Percentage, e.g. "8.25" — converted to a fraction for storage. */
  ratePercent: z.string().regex(/^\d{1,2}(\.\d{1,4})?$/),
  active: z.boolean().optional(),
});

salesRouter.get(
  '/tax-rates',
  requirePermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const rows = await getDb()
      .select()
      .from(taxRates)
      .where(eq(taxRates.organizationId, ctx.organizationId))
      .orderBy(asc(taxRates.name))
      .limit(1000);
    res.json({ items: rows });
  }),
);

salesRouter.post(
  '/tax-rates',
  requirePermission('invoices.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, TaxRateSchema);
    // percent -> fraction with exact string math (divide by 100 = shift).
    const { div, roundMoney: _rm } = await import('@shared/money');
    const fraction = div(body.ratePercent, '100');
    const [row] = await getDb()
      .insert(taxRates)
      .values({
        organizationId: ctx.organizationId,
        name: body.name,
        agencyName: body.agencyName ?? '',
        rate: fraction,
        active: body.active ?? true,
      })
      .returning()
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict('DUPLICATE_TAX_RATE', 'A tax rate with this name already exists');
        }
        throw err;
      });
    res.status(201).json(row);
  }),
);

/* -------------------------------- Estimates ------------------------------ */

const SalesLineSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  description: z.string().max(1000).optional(),
  quantity: MoneyString,
  unitPrice: MoneyString,
  taxable: z.boolean().optional(),
  incomeAccountId: z.string().uuid().optional().nullable(),
});

const EstimateSchema = z.object({
  customerId: z.string().uuid(),
  estimateDate: DateString,
  expirationDate: DateString.optional().nullable(),
  memo: z.string().max(2000).optional(),
  customerMessage: z.string().max(2000).optional(),
  taxRateId: z.string().uuid().optional().nullable(),
  lines: z.array(SalesLineSchema).min(1).max(200),
});

salesRouter.get(
  '/estimates',
  requirePermission('estimates.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const conditions = [eq(estimates.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${estimates.estimateDate}, ${estimates.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await getDb()
      .select({
        id: estimates.id,
        number: estimates.number,
        customerId: estimates.customerId,
        customerName: customers.displayName,
        status: estimates.status,
        estimateDate: estimates.estimateDate,
        expirationDate: estimates.expirationDate,
        total: estimates.total,
      })
      .from(estimates)
      .innerJoin(customers, eq(estimates.customerId, customers.id))
      .where(and(...conditions))
      .orderBy(desc(estimates.estimateDate), desc(estimates.number))
      .limit(query.limit + 1);
    const page = pageResult(rows, query.limit, (r) => [r.estimateDate, r.number]);
    res.json({ items: page.items, nextCursor: page.nextCursor });
  }),
);

salesRouter.get(
  '/estimates/:id',
  requirePermission('estimates.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [row] = await db
      .select()
      .from(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.organizationId, ctx.organizationId)))
      .limit(1);
    if (!row) throw AppError.notFound('Estimate not found');
    const lines = await db
      .select()
      .from(estimateLines)
      .where(eq(estimateLines.estimateId, id))
      .orderBy(asc(estimateLines.lineNumber));
    const { roundMoney } = await import('@shared/money');
    res.json({
      ...row,
      subtotal: roundMoney(row.subtotal),
      taxTotal: roundMoney(row.taxTotal),
      total: roundMoney(row.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
    });
  }),
);

salesRouter.post(
  '/estimates',
  requirePermission('estimates.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, EstimateSchema);
    const result = await createEstimateDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

const TransitionSchema = z.object({
  status: z.enum(['sent', 'accepted', 'rejected', 'expired', 'closed']),
  acceptedByName: z.string().max(200).optional(),
  acceptedSource: z.string().max(60).optional(),
});

salesRouter.post(
  '/estimates/:id/transition',
  requirePermission('estimates.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, TransitionSchema);
    await transitionEstimate(getDb(), ctx, id, body, req.correlationId);
    res.json({ ok: true });
  }),
);

const ConvertSchema = z.object({
  invoiceDate: DateString,
  selections: z
    .array(z.object({ estimateLineId: z.string().uuid(), quantity: MoneyString }))
    .optional(),
});

salesRouter.post(
  '/estimates/:id/convert',
  requirePermission('invoices.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, ConvertSchema);
    const result = await convertEstimateToInvoice(getDb(), ctx, id, body, req.correlationId);
    res.status(201).json(result);
  }),
);
