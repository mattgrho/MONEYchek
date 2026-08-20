import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { customerRetainers, customers, invoices, retainerApplications } from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseParams, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { AppError } from '../lib/errors';
import { PageQuery, decodeCursor, pageResult } from '../lib/pagination';
import {
  applyRetainer,
  receiveRetainer,
  unapplyRetainerApplication,
  voidRetainer,
} from '../services/retainers';

export const retainersRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const IdemKey = z.string().min(8).max(200);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });

interface RetainerListRow {
  id: string;
  number: string;
  customer_id: string;
  customer_name: string;
  posting_status: string;
  received_date: string;
  amount: string;
  balance: string;
}

retainersRouter.get(
  '/retainers',
  requirePermission('retainers.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, PageQuery.extend({ customerId: z.string().uuid().optional() }));
    const after = query.cursor ? decodeCursor(query.cursor, 2) : null;
    const result = await getDb().execute(sql`
      SELECT r.id, r.number, r.customer_id, c.display_name AS customer_name,
             r.posting_status, r.received_date::text AS received_date, r.amount::text,
             (r.amount
               - COALESCE((SELECT SUM(ra.amount) FROM retainer_applications ra
                           WHERE ra.retainer_id = r.id), 0)
             )::text AS balance
      FROM customer_retainers r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.organization_id = ${ctx.organizationId}
        ${query.customerId ? sql`AND r.customer_id = ${query.customerId}` : sql``}
        ${after ? sql`AND (r.received_date, r.number) < (${after[0]}::date, ${after[1]})` : sql``}
      ORDER BY r.received_date DESC, r.number DESC
      LIMIT ${query.limit + 1}
    `);
    const { roundMoney } = await import('@shared/money');
    const page = pageResult(result.rows as unknown as RetainerListRow[], query.limit, (r) => [
      r.received_date,
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
        receivedDate: r.received_date,
        amount: roundMoney(r.amount),
        balance: r.posting_status === 'posted' ? roundMoney(r.balance) : '0.00',
      })),
    });
  }),
);

retainersRouter.get(
  '/retainers/:id',
  requirePermission('retainers.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [retainer] = await db
      .select()
      .from(customerRetainers)
      .where(
        and(eq(customerRetainers.id, id), eq(customerRetainers.organizationId, ctx.organizationId)),
      )
      .limit(1);
    if (!retainer) throw AppError.notFound('Retainer not found');
    const [customer] = await db
      .select({ displayName: customers.displayName })
      .from(customers)
      .where(eq(customers.id, retainer.customerId))
      .limit(1);
    const applications = await db
      .select({
        id: retainerApplications.id,
        invoiceId: retainerApplications.invoiceId,
        invoiceNumber: invoices.number,
        amount: retainerApplications.amount,
        effectiveDate: retainerApplications.effectiveDate,
        reversalOfApplicationId: retainerApplications.reversalOfApplicationId,
      })
      .from(retainerApplications)
      .innerJoin(invoices, eq(retainerApplications.invoiceId, invoices.id))
      .where(eq(retainerApplications.retainerId, id))
      .orderBy(asc(retainerApplications.createdAt));
    const { roundMoney, sum, sub } = await import('@shared/money');
    const applied = sum(applications.map((a) => a.amount));
    res.json({
      ...retainer,
      customerName: customer?.displayName ?? '',
      amount: roundMoney(retainer.amount),
      balance:
        retainer.postingStatus === 'posted' ? roundMoney(sub(retainer.amount, applied)) : '0.00',
      applications: applications.map((a) => ({ ...a, amount: roundMoney(a.amount) })),
    });
  }),
);

retainersRouter.post(
  '/retainers',
  requirePermission('retainers.create'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(
      req,
      z.object({
        customerId: z.string().uuid(),
        receivedDate: DateString,
        amount: MoneyString,
        depositToAccountId: z.string().uuid(),
        method: z.string().max(40).optional(),
        reference: z.string().max(80).optional(),
        memo: z.string().max(2000).optional(),
        idempotencyKey: IdemKey,
      }),
    );
    const result = await receiveRetainer(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);

retainersRouter.post(
  '/retainers/:id/apply',
  requirePermission('retainers.edit'),
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
    const result = await applyRetainer(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

retainersRouter.post(
  '/retainer-applications/:id/unapply',
  requirePermission('retainers.edit'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(req, z.object({ effectiveDate: DateString, idempotencyKey: IdemKey }));
    const result = await unapplyRetainerApplication(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);

retainersRouter.post(
  '/retainers/:id/void',
  requirePermission('retainers.void'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const body = parseBody(
      req,
      z.object({ reason: z.string().min(3).max(500), idempotencyKey: IdemKey }),
    );
    const result = await voidRetainer(getDb(), ctx, id, body, req.correlationId);
    res.json(result);
  }),
);
