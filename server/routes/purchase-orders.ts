import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { bills, purchaseOrderLines, purchaseOrders, vendors } from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  convertPurchaseOrderToBill,
  createPurchaseOrderDraft,
  transitionPurchaseOrder,
  updatePurchaseOrderDraft,
} from '../services/purchase-orders';

export const purchaseOrdersRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });

const PoLineSchema = z.object({
  productId: z.string().uuid().optional().nullable(),
  accountId: z.string().uuid().optional().nullable(),
  description: z.string().max(1000).optional(),
  quantity: MoneyString,
  unitCost: MoneyString,
});

const PoSchema = z.object({
  vendorId: z.string().uuid(),
  poDate: DateString,
  expectedDate: DateString.optional().nullable(),
  shipTo: z.string().max(500).optional().nullable(),
  memo: z.string().max(2000).optional(),
  vendorMessage: z.string().max(2000).optional(),
  lines: z.array(PoLineSchema).min(1).max(200),
});

purchaseOrdersRouter.get(
  '/purchase-orders',
  requirePermission('purchase_orders.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery);
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const conditions = [eq(purchaseOrders.organizationId, ctx.organizationId)];
    if (after) {
      conditions.push(
        sql`(${purchaseOrders.poDate}, ${purchaseOrders.number}) < (${after[0]}::date, ${after[1]})`,
      );
    }
    const rows = await getDb()
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        vendorId: purchaseOrders.vendorId,
        vendorName: vendors.displayName,
        status: purchaseOrders.status,
        poDate: purchaseOrders.poDate,
        expectedDate: purchaseOrders.expectedDate,
        total: purchaseOrders.total,
      })
      .from(purchaseOrders)
      .innerJoin(vendors, eq(purchaseOrders.vendorId, vendors.id))
      .where(and(...conditions))
      .orderBy(sql`${purchaseOrders.poDate} DESC`, sql`${purchaseOrders.number} DESC`)
      .limit(query.limit + 1);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(rows, query.limit, (r) => [r.poDate, r.number]);
    res.json({
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({ ...r, total: roundMoney(r.total) })),
    });
  }),
);

purchaseOrdersRouter.get(
  '/purchase-orders/:id',
  requirePermission('purchase_orders.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [po] = await db
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.organizationId, ctx.organizationId)))
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    const lines = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineNumber));
    const linkedBills = await db
      .select({
        id: bills.id,
        number: bills.number,
        billDate: bills.billDate,
        postingStatus: bills.postingStatus,
        total: bills.total,
      })
      .from(bills)
      .where(and(eq(bills.purchaseOrderId, id), eq(bills.organizationId, ctx.organizationId)))
      .orderBy(asc(bills.billDate));
    const { roundMoney } = await import('@shared/money');
    res.json({
      ...po,
      total: roundMoney(po.total),
      lines: lines.map((l) => ({ ...l, amount: roundMoney(l.amount) })),
      bills: linkedBills.map((b) => ({ ...b, total: roundMoney(b.total) })),
    });
  }),
);

purchaseOrdersRouter.post(
  '/purchase-orders',
  requirePermission('purchase_orders.create'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(req, PoSchema);
    const result = await createPurchaseOrderDraft(getDb(), ctx, body);
    res.status(201).json(result);
  }),
);

purchaseOrdersRouter.patch(
  '/purchase-orders/:id',
  requirePermission('purchase_orders.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, PoSchema.partial().omit({ vendorId: true }));
    await updatePurchaseOrderDraft(getDb(), ctx, id, body);
    res.json({ ok: true });
  }),
);

purchaseOrdersRouter.post(
  '/purchase-orders/:id/transition',
  requirePermission('purchase_orders.edit'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ to: z.enum(['open', 'closed', 'canceled']) }));
    await transitionPurchaseOrder(getDb(), ctx, id, body.to, req.correlationId);
    res.json({ ok: true });
  }),
);

purchaseOrdersRouter.post(
  '/purchase-orders/:id/convert',
  requirePermission('bills.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({
        billDate: DateString,
        vendorReference: z.string().max(80).optional(),
        selections: z
          .array(z.object({ poLineId: z.string().uuid(), quantity: MoneyString }))
          .min(1)
          .optional(),
      }),
    );
    const result = await convertPurchaseOrderToBill(getDb(), ctx, id, body, req.correlationId);
    res.status(201).json(result);
  }),
);
