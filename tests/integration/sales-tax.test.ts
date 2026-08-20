import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let customerId: string;
let checkingId: string;
let stateRateId: string;
let cityRateId: string;

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

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Tax Center Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const accounts = await get('/api/v1/accounts');
  checkingId = accounts.body.items.find((a: { name: string }) => a.name === 'Checking').id;
  const customer = await post('/api/v1/customers', { displayName: 'Taxed Customer' });
  customerId = customer.body.id;
  const state = await post('/api/v1/tax-rates', {
    name: 'State Tax',
    agencyName: 'State Department of Revenue',
    ratePercent: '6',
  });
  stateRateId = state.body.id;
  const city = await post('/api/v1/tax-rates', {
    name: 'City Tax',
    agencyName: 'City Treasurer',
    ratePercent: '2',
  });
  cityRateId = city.body.id;

  // Two state-taxed invoices (100 and 200 taxable), one city-taxed sales
  // receipt (50), one state-taxed credit memo (-100).
  for (const [amount, key] of [
    ['100', 'tax-inv-1'],
    ['200', 'tax-inv-2'],
  ] as const) {
    const inv = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2026-08-05',
      taxRateId: stateRateId,
      lines: [{ description: 'Work', quantity: '1', unitPrice: amount, taxable: true }],
    });
    await post(`/api/v1/invoices/${inv.body.id}/post`, { idempotencyKey: `${key}-00000001` });
  }
  const receipt = await post('/api/v1/sales-receipts', {
    customerId,
    receiptDate: '2026-08-10',
    depositToAccountId: checkingId,
    taxRateId: cityRateId,
    lines: [{ description: 'Walk-in sale', quantity: '1', unitPrice: '50', taxable: true }],
    idempotencyKey: 'tax-sr-1-00000001',
  });
  expect(receipt.status).toBe(201);
  const memo = await post('/api/v1/credit-memos', {
    customerId,
    creditDate: '2026-08-15',
    taxRateId: stateRateId,
    lines: [{ description: 'Returned work', quantity: '1', unitPrice: '100', taxable: true }],
  });
  const posted = await post(`/api/v1/credit-memos/${memo.body.id}/post`, {
    idempotencyKey: 'tax-cm-1-00000001',
  });
  expect(posted.status).toBe(200);
});

describe('sales-tax center', () => {
  it('reports collections per agency from posted documents', async () => {
    const res = await get('/api/v1/sales-tax/liability?startDate=2026-08-01&endDate=2026-08-31');
    expect(res.status).toBe(200);
    const state = res.body.agencies.find(
      (a: { agencyName: string }) => a.agencyName === 'State Department of Revenue',
    );
    // 6% of (100 + 200 - 100) = 12.00; taxable 200.00
    expect(state.taxCollected).toBe('12.00');
    expect(state.taxableSales).toBe('200.00');
    const city = res.body.agencies.find(
      (a: { agencyName: string }) => a.agencyName === 'City Treasurer',
    );
    // 2% of 50 = 1.00
    expect(city.taxCollected).toBe('1.00');
    expect(res.body.totalCollected).toBe('13.00');
    expect(res.body.remittedInPeriod).toBe('0.00');
    // Nothing remitted yet: ledger liability equals everything collected.
    expect(res.body.ledgerBalanceAsOf).toBe('13.00');
  });

  it('records a remittance that reduces the ledger liability', async () => {
    const res = await post('/api/v1/sales-tax/payments', {
      paymentDate: '2026-09-05',
      amount: '12.00',
      bankAccountId: checkingId,
      agencyName: 'State Department of Revenue',
      idempotencyKey: 'tax-pay-1-00000001',
    });
    expect(res.status).toBe(201);

    const report = await get('/api/v1/sales-tax/liability?startDate=2026-09-01&endDate=2026-09-30');
    expect(report.body.remittedInPeriod).toBe('12.00');
    expect(report.body.ledgerBalanceAsOf).toBe('1.00');

    const payments = await get('/api/v1/sales-tax/payments');
    expect(payments.body.items.length).toBe(1);
    expect(payments.body.items[0].amount).toBe('12.00');
    expect(payments.body.items[0].memo).toContain('State Department of Revenue');
  });

  it('rejects remittances from controlled accounts', async () => {
    const accounts = await get('/api/v1/accounts');
    const uf = accounts.body.items.find(
      (a: { systemKey: string | null }) => a.systemKey === 'undeposited_funds',
    );
    const res = await post('/api/v1/sales-tax/payments', {
      paymentDate: '2026-09-06',
      amount: '1.00',
      bankAccountId: uf.id,
      idempotencyKey: 'tax-pay-2-00000001',
    });
    expect(res.status).toBe(422);
  });

  it('edits a rate without touching posted documents', async () => {
    const res = await patch(`/api/v1/tax-rates/${cityRateId}`, {
      ratePercent: '2.5',
      agencyName: 'City Treasurer Office',
    });
    expect(res.status).toBe(200);
    expect(res.body.rate).toBe('0.02500000');

    // The already-posted receipt keeps its historical agency grouping via
    // the rate row, but its frozen tax amount is untouched.
    const report = await get('/api/v1/sales-tax/liability?startDate=2026-08-01&endDate=2026-08-31');
    const city = report.body.agencies.find((a: { agencyName: string }) =>
      a.agencyName.startsWith('City Treasurer'),
    );
    expect(city.taxCollected).toBe('1.00');
  });

  it('deactivating a rate hides it from new-document pickers', async () => {
    const res = await patch(`/api/v1/tax-rates/${stateRateId}`, { active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });
});
