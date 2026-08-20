import { Router } from 'express';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import {
  brandSettings,
  companyProfiles,
  creditMemoLines,
  creditMemos,
  customers,
  estimateLines,
  estimates,
  invoiceLines,
  invoices,
  purchaseOrderLines,
  purchaseOrders,
  vendors,
} from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler, parseParams, parseQuery } from '../middleware/validate';
import { AppError } from '../lib/errors';
import { hslTripletToHex } from '../lib/colors';
import { companyToday } from '../lib/dates';
import { renderSalesDocumentPdf, renderStatementPdf, type DocumentBrand } from '../pdf/documents';
import { invoiceOpenBalance } from '../services/invoices';
import { formatQuantityForApi } from '../lib/format';
import { add, neg, roundMoney, sub } from '@shared/money';

export const documentsRouter = Router();

const IdParam = z.object({ id: z.string().uuid() });
const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

async function loadBrand(
  organizationId: string,
): Promise<DocumentBrand & { currency: string; timeZone: string }> {
  const db = getDb();
  const [profile] = await db
    .select()
    .from(companyProfiles)
    .where(eq(companyProfiles.organizationId, organizationId))
    .limit(1);
  const [brand] = await db
    .select()
    .from(brandSettings)
    .where(eq(brandSettings.organizationId, organizationId))
    .limit(1);
  const primaryToken = brand?.tokens['primary'];
  const business = profile?.addresses?.['business'];
  const addressLines = business
    ? [
        business.line1,
        business.line2,
        [business.city, business.region, business.postalCode].filter(Boolean).join(', '),
      ].filter((l): l is string => Boolean(l && l.trim()))
    : [];
  return {
    companyDisplayName: profile?.displayName || 'Company',
    applicationName: profile?.applicationName ?? null,
    primaryColorHex: (primaryToken && hslTripletToHex(primaryToken)) || '#1f3a5f',
    addressLines,
    phone: profile?.phone ?? null,
    supportEmail: profile?.supportEmail ?? null,
    website: profile?.website ?? null,
    legalFooter: profile?.legalFooter ?? null,
    paymentInstructions: profile?.paymentInstructions ?? null,
    documentDisclaimer: profile?.documentDisclaimer ?? null,
    currency: profile?.homeCurrency ?? 'USD',
    timeZone: profile?.timeZone ?? 'America/New_York',
  };
}

function sendPdf(res: import('express').Response, filename: string, pdf: Buffer): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.send(pdf);
}

documentsRouter.get(
  '/invoices/:id/pdf',
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
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, invoice.customerId))
      .limit(1);
    const brand = await loadBrand(ctx.organizationId);

    // Posted invoices render from their FROZEN document snapshot; drafts and
    // voided documents render current data with an explicit status label.
    const frozen = invoice.frozenDocument as {
      lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
      subtotal: string;
      taxTotal: string;
      total: string;
    } | null;
    let lines: { description: string; quantity: string; unitPrice: string; amount: string }[];
    if (invoice.postingStatus === 'posted' && frozen) {
      lines = frozen.lines;
    } else {
      const rows = await db
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.lineNumber));
      lines = rows.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      }));
    }
    const openBalance =
      invoice.postingStatus === 'posted'
        ? await db.transaction((tx) => invoiceOpenBalance(tx, id))
        : roundMoney(invoice.total);
    const pdf = await renderSalesDocumentPdf(brand, {
      kind: 'INVOICE',
      number: invoice.number,
      issueDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      status:
        invoice.postingStatus === 'draft'
          ? 'DRAFT'
          : invoice.postingStatus === 'voided'
            ? 'VOID'
            : null,
      customer: {
        name: customer?.displayName ?? 'Customer',
        email: customer?.email ?? null,
        addressLines: customer?.billingAddress
          ? [
              customer.billingAddress['line1'],
              customer.billingAddress['line2'],
              [
                customer.billingAddress['city'],
                customer.billingAddress['region'],
                customer.billingAddress['postalCode'],
              ]
                .filter(Boolean)
                .join(', '),
            ].filter((l): l is string => Boolean(l && l.trim()))
          : [],
      },
      lines: lines.map((l) => ({
        description: l.description,
        quantity: formatQuantityForApi(l.quantity),
        unitPrice: roundMoney(l.unitPrice),
        amount: roundMoney(l.amount),
      })),
      subtotal: roundMoney(invoice.subtotal),
      taxName: invoice.taxSnapshot?.name ?? null,
      taxTotal: roundMoney(invoice.taxTotal),
      total: roundMoney(invoice.total),
      amountPaid: roundMoney(sub(invoice.total, openBalance)),
      balanceDue: openBalance,
      memoToCustomer: invoice.customerMessage,
      currency: brand.currency,
    });
    sendPdf(res, `${invoice.number}.pdf`, pdf);
  }),
);

documentsRouter.get(
  '/estimates/:id/pdf',
  requirePermission('estimates.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const db = getDb();
    const [estimate] = await db
      .select()
      .from(estimates)
      .where(and(eq(estimates.id, id), eq(estimates.organizationId, ctx.organizationId)))
      .limit(1);
    if (!estimate) throw AppError.notFound('Estimate not found');
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, estimate.customerId))
      .limit(1);
    const lines = await db
      .select()
      .from(estimateLines)
      .where(eq(estimateLines.estimateId, id))
      .orderBy(asc(estimateLines.lineNumber));
    const brand = await loadBrand(ctx.organizationId);
    const pdf = await renderSalesDocumentPdf(brand, {
      kind: 'ESTIMATE',
      number: estimate.number,
      issueDate: estimate.estimateDate,
      expirationDate: estimate.expirationDate,
      status: estimate.status === 'draft' ? 'DRAFT' : estimate.status.toUpperCase(),
      customer: { name: customer?.displayName ?? 'Customer', email: customer?.email ?? null },
      lines: lines.map((l) => ({
        description: l.description,
        quantity: formatQuantityForApi(l.quantity),
        unitPrice: roundMoney(l.unitPrice),
        amount: roundMoney(l.amount),
      })),
      subtotal: roundMoney(estimate.subtotal),
      taxTotal: roundMoney(estimate.taxTotal),
      total: roundMoney(estimate.total),
      memoToCustomer: estimate.customerMessage,
      currency: brand.currency,
    });
    sendPdf(res, `${estimate.number}.pdf`, pdf);
  }),
);

documentsRouter.get(
  '/purchase-orders/:id/pdf',
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
    const [vendor] = await db
      .select()
      .from(vendors)
      .where(eq(vendors.id, po.vendorId))
      .limit(1);
    const lines = await db
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, id))
      .orderBy(asc(purchaseOrderLines.lineNumber));
    const brand = await loadBrand(ctx.organizationId);
    const pdf = await renderSalesDocumentPdf(brand, {
      kind: 'PURCHASE ORDER',
      number: po.number,
      issueDate: po.poDate,
      expirationDate: po.expectedDate,
      status: po.status === 'draft' ? 'DRAFT' : po.status.replace('_', ' ').toUpperCase(),
      customer: { name: vendor?.displayName ?? 'Vendor', email: vendor?.email ?? null },
      lines: lines.map((l) => ({
        description: l.description,
        quantity: formatQuantityForApi(l.quantity),
        unitPrice: roundMoney(l.unitCost),
        amount: roundMoney(l.amount),
      })),
      subtotal: roundMoney(po.total),
      taxTotal: '0.00',
      total: roundMoney(po.total),
      memoToCustomer: po.vendorMessage,
      currency: brand.currency,
    });
    sendPdf(res, `${po.number}.pdf`, pdf);
  }),
);

documentsRouter.get(
  '/credit-memos/:id/pdf',
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
    const [customer] = await db
      .select()
      .from(customers)
      .where(eq(customers.id, credit.customerId))
      .limit(1);
    const lines = await db
      .select()
      .from(creditMemoLines)
      .where(eq(creditMemoLines.creditMemoId, id))
      .orderBy(asc(creditMemoLines.lineNumber));
    const brand = await loadBrand(ctx.organizationId);
    const pdf = await renderSalesDocumentPdf(brand, {
      kind: 'CREDIT MEMO',
      number: credit.number,
      issueDate: credit.creditDate,
      status: credit.postingStatus === 'draft' ? 'DRAFT' : null,
      customer: { name: customer?.displayName ?? 'Customer', email: customer?.email ?? null },
      lines: lines.map((l) => ({
        description: l.description,
        quantity: formatQuantityForApi(l.quantity),
        unitPrice: roundMoney(l.unitPrice),
        amount: roundMoney(l.amount),
      })),
      subtotal: roundMoney(credit.subtotal),
      taxTotal: roundMoney(credit.taxTotal),
      total: roundMoney(credit.total),
      memoToCustomer: credit.memo,
      currency: brand.currency,
    });
    sendPdf(res, `${credit.number}.pdf`, pdf);
  }),
);

/**
 * Open-item customer statement: every open invoice and unapplied credit as of
 * the statement date. Totals tie to the AR subledger by construction (same
 * dated-allocation math as the aging report).
 */
documentsRouter.get(
  '/customers/:id/statement',
  requirePermission('invoices.view'),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const { id } = parseParams(req, IdParam);
    const query = parseQuery(
      req,
      z.object({ asOf: DateString.optional(), format: z.enum(['json', 'pdf']).default('json') }),
    );
    const db = getDb();
    const [customer] = await db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.organizationId, ctx.organizationId)))
      .limit(1);
    if (!customer) throw AppError.notFound('Customer not found');
    const brand = await loadBrand(ctx.organizationId);
    const asOf = query.asOf ?? companyToday(brand.timeZone);

    const { arAging } = await import('../reports/ar');
    const aging = await arAging(db, ctx.organizationId, asOf);
    const detail = aging.detail.filter((d) => d.customerId === id);
    let running = '0';
    const rows = detail.map((d) => {
      running = add(running, d.amount);
      return {
        date: d.date,
        kind:
          d.kind === 'invoice'
            ? 'Invoice'
            : d.kind === 'credit_memo'
              ? 'Credit memo'
              : 'Unapplied payment',
        number: d.number,
        amount: d.amount,
        balance: roundMoney(running),
      };
    });
    const endingBalance = roundMoney(running);
    if (query.format === 'pdf') {
      const pdf = await renderStatementPdf(brand, {
        customerName: customer.displayName,
        asOf,
        rows,
        endingBalance,
        currency: brand.currency,
      });
      sendPdf(
        res,
        `statement-${customer.displayName.replace(/[^A-Za-z0-9-]+/g, '_')}-${asOf}.pdf`,
        pdf,
      );
      return;
    }
    res.json({ customerId: id, customerName: customer.displayName, asOf, rows, endingBalance });
  }),
);

export { neg as _negInternal };
