import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let vendorId: string;
let customerId: string;
let productId: string;

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

async function expectValuation(expected: {
  quantity: string;
  value: string;
}): Promise<Record<string, unknown>> {
  const res = await get('/api/v1/inventory/valuation');
  expect(res.status).toBe(200);
  expect(res.body.tiesToLedger).toBe(true);
  const row = res.body.rows.find((r: { productId: string }) => r.productId === productId);
  expect(row, 'valuation row for the product').toBeTruthy();
  expect(row.quantityOnHand).toBe(expected.quantity);
  expect(row.value).toBe(expected.value);
  return res.body;
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Inventory Test Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const vendor = await post('/api/v1/vendors', { displayName: 'Stock Supplier' });
  vendorId = vendor.body.id;
  const customer = await post('/api/v1/customers', { displayName: 'Stock Buyer' });
  customerId = customer.body.id;
});

describe('inventory module', () => {
  it('creates an inventory-type product through the API', async () => {
    const res = await post('/api/v1/products', {
      type: 'inventory',
      name: 'Cedar Plank',
      sku: 'CP-01',
      salesPrice: '45',
      purchaseCost: '20',
      unitLabel: 'ea',
      taxable: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('inventory');
    productId = res.body.id;
  });

  it('a posted bill receives stock into FIFO layers and ties to the GL', async () => {
    const bill = await post('/api/v1/bills', {
      vendorId,
      billDate: '2026-07-01',
      lines: [{ productId, quantity: '10', unitCost: '20' }],
    });
    expect(bill.status).toBe(201);
    const posted = await post(`/api/v1/bills/${bill.body.id}/post`, {
      idempotencyKey: 'inv-bill-post-01',
    });
    expect(posted.status).toBe(200);
    await expectValuation({ quantity: '10', value: '200.00' });
  });

  it('a posted invoice consumes FIFO layers at exact cost', async () => {
    const invoice = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2026-07-05',
      lines: [{ productId, quantity: '4', unitPrice: '45' }],
    });
    expect(invoice.status).toBe(201);
    const posted = await post(`/api/v1/invoices/${invoice.body.id}/post`, {
      idempotencyKey: 'inv-inv-post-01',
    });
    expect(posted.status).toBe(200);
    await expectValuation({ quantity: '6', value: '120.00' });
  });

  it('adjusts stock down at FIFO cost with an audited reason', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      productId,
      adjustmentDate: '2026-07-10',
      direction: 'decrease',
      quantity: '2',
      reason: 'Damaged in storage',
      idempotencyKey: 'inv-adj-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.totalValue).toBe('40.00');
    await expectValuation({ quantity: '4', value: '80.00' });

    const list = await get('/api/v1/inventory/adjustments');
    expect(list.body.items.length).toBe(1);
    expect(list.body.items[0].direction).toBe('decrease');
    expect(list.body.items[0].reason).toBe('Damaged in storage');
  });

  it('adjusts stock up at a stated unit cost', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      productId,
      adjustmentDate: '2026-07-12',
      direction: 'increase',
      quantity: '3',
      unitCost: '22',
      reason: 'Count correction after physical count',
      idempotencyKey: 'inv-adj-02',
    });
    expect(res.status).toBe(201);
    expect(res.body.totalValue).toBe('66.00');
    await expectValuation({ quantity: '7', value: '146.00' });
  });

  it('an increase without a unit cost is rejected', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      productId,
      adjustmentDate: '2026-07-12',
      direction: 'increase',
      quantity: '1',
      reason: 'missing cost',
      idempotencyKey: 'inv-adj-03',
    });
    expect(res.status).toBe(400);
  });

  it('negative stock is rejected by the subledger', async () => {
    const res = await post('/api/v1/inventory/adjustments', {
      productId,
      adjustmentDate: '2026-07-13',
      direction: 'decrease',
      quantity: '100',
      reason: 'attempt to drive stock negative',
      idempotencyKey: 'inv-adj-04',
    });
    expect(res.status).toBe(422);
    await expectValuation({ quantity: '7', value: '146.00' });
  });

  it('adjustments only apply to inventory-type products', async () => {
    const service = await post('/api/v1/products', {
      type: 'service',
      name: 'Consulting',
      salesPrice: '100',
    });
    const res = await post('/api/v1/inventory/adjustments', {
      productId: service.body.id,
      adjustmentDate: '2026-07-13',
      direction: 'decrease',
      quantity: '1',
      reason: 'not inventory',
      idempotencyKey: 'inv-adj-05',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('NOT_INVENTORY');
  });

  it('the close checklist inventory tie-out passes with live layers', async () => {
    const res = await get('/api/v1/periods/close-checklist?through=2026-07-31');
    const item = res.body.items.find((i: { key: string }) => i.key === 'inventory_tie_out');
    expect(item).toBeTruthy();
    expect(item.status).toBe('pass');
  });
});
