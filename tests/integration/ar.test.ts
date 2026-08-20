import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let orgId: string;
let customerId: string;
let productId: string;
let taxRateId: string;
let checkingId: string;
let ufId: string;

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function patch(url: string, body: unknown) {
  return request(app)
    .patch(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

async function expectArTiesToControl(asOf: string) {
  const res = await get(`/api/v1/reports/ar-aging?asOf=${asOf}`);
  expect(res.status).toBe(200);
  expect(res.body.tiesToControl).toBe(true);
  return res.body;
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  orgId = await bootstrapCompany(app, 'Riverbend Services');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const accounts = await get('/api/v1/accounts');
  checkingId = accounts.body.items.find((a: { name: string }) => a.name === 'Checking').id;
  ufId = accounts.body.items.find(
    (a: { systemKey: string | null }) => a.systemKey === 'undeposited_funds',
  ).id;

  const customer = await post('/api/v1/customers', {
    displayName: 'Harbor Cafe',
    email: 'ap@harborcafe.test',
    termsDays: 30,
  });
  expect(customer.status).toBe(201);
  customerId = customer.body.id;

  const product = await post('/api/v1/products', {
    type: 'service',
    name: 'Consulting Hours',
    salesPrice: '150',
    taxable: true,
  });
  expect(product.status).toBe(201);
  productId = product.body.id;

  const rate = await post('/api/v1/tax-rates', {
    name: 'State Sales Tax',
    agencyName: 'State Department of Revenue',
    ratePercent: '8.25',
  });
  expect(rate.status).toBe(201);
  taxRateId = rate.body.id;
  expect(rate.body.rate).toBe('0.08250000');
});

describe('quote to cash', () => {
  let estimateId: string;
  let invoiceId: string;
  let paymentId: string;

  it('creates an estimate with exact totals', async () => {
    const res = await post('/api/v1/estimates', {
      customerId,
      estimateDate: '2025-05-01',
      taxRateId,
      lines: [
        { productId, quantity: '10', unitPrice: '150', taxable: true },
        { description: 'Materials (non-taxable)', quantity: '1', unitPrice: '200', taxable: false },
      ],
    });
    expect(res.status).toBe(201);
    estimateId = res.body.id;
    const detail = await get(`/api/v1/estimates/${estimateId}`);
    expect(detail.body.subtotal).toBe('1700.00');
    // 1500 * 8.25% = 123.75
    expect(detail.body.taxTotal).toBe('123.75');
    expect(detail.body.total).toBe('1823.75');
  });

  it('converts selected quantities into a draft invoice, preventing overbilling', async () => {
    await post(`/api/v1/estimates/${estimateId}/transition`, { status: 'sent' });
    await post(`/api/v1/estimates/${estimateId}/transition`, {
      status: 'accepted',
      acceptedByName: 'Dana Harbor',
    });
    const detail = await get(`/api/v1/estimates/${estimateId}`);
    const serviceLine = detail.body.lines.find(
      (l: { productId: string }) => l.productId === productId,
    );

    const over = await post(`/api/v1/estimates/${estimateId}/convert`, {
      invoiceDate: '2025-05-05',
      selections: [{ estimateLineId: serviceLine.id, quantity: '11' }],
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERBILLING_BLOCKED');

    const partial = await post(`/api/v1/estimates/${estimateId}/convert`, {
      invoiceDate: '2025-05-05',
      selections: [{ estimateLineId: serviceLine.id, quantity: '6' }],
    });
    expect(partial.status).toBe(201);
    invoiceId = partial.body.invoiceId;

    const est = await get(`/api/v1/estimates/${estimateId}`);
    expect(est.body.status).toBe('partially_converted');

    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.subtotal).toBe('900.00');
    expect(invoice.body.taxTotal).toBe('74.25');
    expect(invoice.body.total).toBe('974.25');
    expect(invoice.body.postingStatus).toBe('draft');
  });

  it('posts the invoice: AR, revenue, and tax hit the ledger; aging ties to control', async () => {
    const res = await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'inv-post-1' });
    expect(res.status).toBe(200);

    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-05-31');
    expect(tb.body.totalDebits).toBe(tb.body.totalCredits);
    const stp = tb.body.rows.find((r: { name: string }) => r.name === 'Sales Tax Payable');
    expect(stp.credit).toBe('74.25');

    const aging = await expectArTiesToControl('2025-05-31');
    expect(aging.total).toBe('974.25');

    // Posting again with the same key replays; a new key conflicts with state.
    const replay = await post(`/api/v1/invoices/${invoiceId}/post`, {
      idempotencyKey: 'inv-post-1',
    });
    expect(replay.status).toBe(200);
    const dup = await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'inv-post-2' });
    expect(dup.status).toBe(409);
  });

  it('drafts cannot be edited after posting', async () => {
    const res = await patch(`/api/v1/invoices/${invoiceId}`, { memo: 'sneaky edit' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_DRAFT');
  });

  it('receives a partial payment into Undeposited Funds with allocation', async () => {
    const res = await post('/api/v1/payments', {
      customerId,
      paymentDate: '2025-05-10',
      amount: '500',
      depositToAccountId: ufId,
      method: 'check',
      reference: '1042',
      allocations: [{ invoiceId, amount: '500' }],
      idempotencyKey: 'pay-00001',
    });
    expect(res.status).toBe(201);
    paymentId = res.body.id;

    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.openBalance).toBe('474.25');
    await expectArTiesToControl('2025-05-31');
  });

  it('prevents over-application, including a concurrent race', async () => {
    const over = await post(`/api/v1/payments/${paymentId}/apply`, {
      allocations: [{ invoiceId, amount: '1' }],
      effectiveDate: '2025-05-11',
      idempotencyKey: 'pay-apply-over',
    });
    // Payment is fully applied already (500 of 500).
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVER_APPLICATION');

    // Two racing payments each try to take the whole remaining 474.25.
    const mk = (key: string) =>
      post('/api/v1/payments', {
        customerId,
        paymentDate: '2025-05-12',
        amount: '474.25',
        depositToAccountId: ufId,
        allocations: [{ invoiceId, amount: '474.25' }],
        idempotencyKey: key,
      });
    const [a, b] = await Promise.all([mk('race-00001'), mk('race-00002')]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBe(422);

    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.openBalance).toBe('0.00');
    await expectArTiesToControl('2025-05-31');
  });

  it('groups Undeposited Funds receipts into one bank deposit', async () => {
    const undeposited = await get('/api/v1/undeposited-receipts');
    expect(undeposited.body.items.length).toBe(2);
    const res = await post('/api/v1/deposits', {
      depositDate: '2025-05-15',
      bankAccountId: checkingId,
      receipts: undeposited.body.items.map((r: { sourceType: string; sourceId: string }) => ({
        sourceType: r.sourceType,
        sourceId: r.sourceId,
      })),
      otherLines: [],
      idempotencyKey: 'dep-00001',
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe('974.25');

    // UF is fully cleared; bank carries the funds.
    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-05-31');
    const uf = tb.body.rows.find((r: { name: string }) => r.name === 'Undeposited Funds');
    expect(uf).toBeUndefined();

    // Receipts cannot be deposited twice.
    const again = await post('/api/v1/deposits', {
      depositDate: '2025-05-16',
      bankAccountId: checkingId,
      receipts: [
        {
          sourceType: 'customer_payment',
          sourceId: paymentId,
        },
      ],
      idempotencyKey: 'dep-00002',
    });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('RECEIPT_UNAVAILABLE');
  });

  it('voiding an applied payment is blocked until unapplied', async () => {
    const res = await post(`/api/v1/payments/${paymentId}/void`, {
      idempotencyKey: 'pay-void-1',
      reason: 'testing guard',
    });
    expect(res.status).toBe(422);
    expect(['PAYMENT_HAS_APPLICATIONS', 'PAYMENT_DEPOSITED']).toContain(res.body.error.code);
  });
});

describe('credits, refunds, and write-offs', () => {
  let invoiceId: string;
  let creditId: string;

  beforeAll(async () => {
    const inv = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2025-06-01',
      taxRateId: null,
      lines: [
        {
          productId,
          description: 'June retainer',
          quantity: '2',
          unitPrice: '150',
          taxable: false,
        },
      ],
    });
    invoiceId = inv.body.id;
    await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'inv-june-1' });
  });

  it('applies a posted credit memo to an invoice and refunds the rest', async () => {
    const credit = await post('/api/v1/credit-memos', {
      customerId,
      creditDate: '2025-06-05',
      lines: [
        {
          productId,
          description: 'Service credit',
          quantity: '1',
          unitPrice: '150',
          taxable: false,
        },
      ],
    });
    expect(credit.status).toBe(201);
    creditId = credit.body.id;
    const posted = await post(`/api/v1/credit-memos/${creditId}/post`, {
      idempotencyKey: 'cm-post-1',
    });
    expect(posted.status).toBe(200);

    const applied = await post(`/api/v1/credit-memos/${creditId}/apply`, {
      allocations: [{ invoiceId, amount: '100' }],
      effectiveDate: '2025-06-06',
      idempotencyKey: 'cm-apply-1',
    });
    expect(applied.status).toBe(200);

    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.openBalance).toBe('200.00');

    const refund = await post('/api/v1/customer-refunds', {
      sourceType: 'credit_memo',
      sourceId: creditId,
      amount: '50',
      refundDate: '2025-06-07',
      bankAccountId: checkingId,
      idempotencyKey: 'cm-refund-1',
    });
    expect(refund.status).toBe(201);

    const overRefund = await post('/api/v1/customer-refunds', {
      sourceType: 'credit_memo',
      sourceId: creditId,
      amount: '1',
      refundDate: '2025-06-08',
      bankAccountId: checkingId,
      idempotencyKey: 'cm-refund-2',
    });
    expect(overRefund.status).toBe(422);

    await expectArTiesToControl('2025-06-30');
  });

  it('writes off the remaining balance as bad debt, bounded by the open amount', async () => {
    const tooMuch = await post(`/api/v1/invoices/${invoiceId}/write-off`, {
      idempotencyKey: 'wo-00001',
      amount: '5000',
      date: '2025-06-20',
      reason: 'uncollectible',
    });
    expect(tooMuch.status).toBe(422);

    const res = await post(`/api/v1/invoices/${invoiceId}/write-off`, {
      idempotencyKey: 'wo-00002',
      amount: '200',
      date: '2025-06-20',
      reason: 'customer ceased trading',
    });
    expect(res.status).toBe(200);

    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.openBalance).toBe('0.00');

    const aging = await expectArTiesToControl('2025-06-30');
    // The June invoice is settled; remaining AR is only the unapplied credit.
    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-06-30');
    const badDebt = tb.body.rows.find((r: { name: string }) => r.name === 'Bad Debt Expense');
    expect(badDebt.debit).toBe('200.00');
    expect(aging.total).toBe('0.00');
  });
});

describe('void with exact reversal', () => {
  it('voids an unpaid invoice and the ledger returns to its prior state', async () => {
    const before = await get('/api/v1/reports/trial-balance?asOf=2025-07-31');
    const inv = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2025-07-01',
      lines: [{ productId, quantity: '1', unitPrice: '999.99', taxable: false }],
    });
    await post(`/api/v1/invoices/${inv.body.id}/post`, { idempotencyKey: 'inv-void-1' });
    const voided = await post(`/api/v1/invoices/${inv.body.id}/void`, {
      idempotencyKey: 'inv-void-2',
      reason: 'duplicate entry',
    });
    expect(voided.status).toBe(200);
    const after = await get('/api/v1/reports/trial-balance?asOf=2025-07-31');
    expect(after.body.totalDebits).toBe(before.body.totalDebits);
    expect(after.body.totalCredits).toBe(before.body.totalCredits);
    await expectArTiesToControl('2025-07-31');
  });

  it('sales receipts post sale and money-in together', async () => {
    const res = await post('/api/v1/sales-receipts', {
      receiptDate: '2025-07-10',
      depositToAccountId: checkingId,
      taxRateId,
      lines: [
        {
          productId,
          description: 'Walk-in service',
          quantity: '1',
          unitPrice: '80',
          taxable: true,
        },
      ],
      idempotencyKey: 'sr-00001',
    });
    expect(res.status).toBe(201);
    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-07-31');
    expect(tb.body.totalDebits).toBe(tb.body.totalCredits);
    await expectArTiesToControl('2025-07-31');
  });
});
