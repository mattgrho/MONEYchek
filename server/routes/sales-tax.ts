import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseBody, parseQuery } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { listTaxPayments, salesTaxLiability } from '../reports/sales-tax';
import { recordTaxPayment } from '../services/sales-tax';

export const salesTaxRouter = Router();

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const MoneyString = z.string().regex(/^\d+(\.\d+)?$/);
const postingLimit = rateLimit({ name: 'posting', limit: 120, windowSeconds: 60 });

salesTaxRouter.get(
  '/sales-tax/liability',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const query = parseQuery(req, z.object({ startDate: DateString, endDate: DateString }));
    res.json(await salesTaxLiability(getDb(), ctx.organizationId, query.startDate, query.endDate));
  }),
);

salesTaxRouter.get(
  '/sales-tax/payments',
  requirePermission('reports.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    res.json({ items: await listTaxPayments(getDb(), ctx.organizationId) });
  }),
);

salesTaxRouter.post(
  '/sales-tax/payments',
  requirePermission('journals.post'),
  postingLimit,
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const body = parseBody(
      req,
      z.object({
        paymentDate: DateString,
        amount: MoneyString,
        bankAccountId: z.string().uuid(),
        agencyName: z.string().max(200).optional(),
        memo: z.string().max(500).optional(),
        idempotencyKey: z.string().min(8).max(200),
      }),
    );
    const result = await recordTaxPayment(getDb(), ctx, body, req.correlationId);
    res.status(201).json(result);
  }),
);
