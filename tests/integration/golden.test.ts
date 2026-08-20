import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

/**
 * The mandatory golden accounting dataset (master spec §30). The sequence and
 * expected values are authoritative; any drift is a bug in the engine, never
 * in this file.
 */

let app: Express;
let orgId: string;
let widgetId: string;
let taxRateId: string;
let vendorId: string;
let customerId: string;
let checkingId: string;
let ufId: string;
let invoiceId: string;
let billId: string;

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

function tbRow(tb: { rows: { name: string; debit: string; credit: string }[] }, name: string) {
  return tb.rows.find((r) => r.name === name);
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  orgId = await bootstrapCompany(app, 'Golden Fixture Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  const db = getDb();
  await db.transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const accounts = await get('/api/v1/accounts');
  checkingId = accounts.body.items.find((a: { name: string }) => a.name === 'Checking').id;
  ufId = accounts.body.items.find(
    (a: { systemKey: string | null }) => a.systemKey === 'undeposited_funds',
  ).id;
  const incomeId = accounts.body.items.find(
    (a: { name: string }) => a.name === 'Service Income',
  ).id;

  // Inventory products are a gated UI feature; the subledger and posting
  // model are fully implemented, so the fixture creates the product directly.
  const { productsServices } = await import('@server/db/schema/index');
  const [widget] = await db
    .insert(productsServices)
    .values({
      organizationId: orgId,
      type: 'inventory',
      name: 'Widget',
      salesPrice: '10',
      purchaseCost: '6',
      incomeAccountId: incomeId,
      taxable: true,
    })
    .returning({ id: productsServices.id });
  widgetId = widget!.id;

  const rate = await post('/api/v1/tax-rates', { name: 'Sales Tax 8.25', ratePercent: '8.25' });
  taxRateId = rate.body.id;
  const vendor = await post('/api/v1/vendors', { displayName: 'Widget Supply Co' });
  vendorId = vendor.body.id;
  const customer = await post('/api/v1/customers', { displayName: 'Golden Customer' });
  customerId = customer.body.id;
});

describe('golden dataset transactions', () => {
  it('T1 owner contribution: Dr Bank 10,000 / Cr Owner Equity 10,000', async () => {
    const accounts = await get('/api/v1/accounts');
    const equityId = accounts.body.items.find(
      (a: { name: string }) => a.name === 'Owner Equity',
    ).id;
    const journal = await post('/api/v1/manual-journals', {
      journalDate: '2025-01-05',
      memo: 'Owner contribution',
      lines: [
        { accountId: checkingId, debit: '10000' },
        { accountId: equityId, credit: '10000' },
      ],
    });
    const posted = await post(`/api/v1/manual-journals/${journal.body.id}/post`, {
      idempotencyKey: 'golden-t1',
    });
    expect(posted.status).toBe(200);
  });

  it('T2 inventory vendor bill: 10 @ $6 + 10 @ $7 -> Dr Inventory 130 / Cr AP 130', async () => {
    const bill = await post('/api/v1/bills', {
      vendorId,
      billDate: '2025-01-10',
      lines: [
        { productId: widgetId, quantity: '10', unitCost: '6' },
        { productId: widgetId, quantity: '10', unitCost: '7' },
      ],
    });
    expect(bill.status).toBe(201);
    billId = bill.body.id;
    const posted = await post(`/api/v1/bills/${billId}/post`, { idempotencyKey: 'golden-t2' });
    expect(posted.status).toBe(200);

    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-01-10');
    expect(tbRow(tb.body, 'Inventory Asset')!.debit).toBe('130.00');
    expect(tbRow(tb.body, 'Accounts Payable')!.credit).toBe('130.00');
  });

  it('T3 taxable inventory invoice: 15 @ $10 + 8.25% -> AR 162.38, tax 12.38, COGS 95 (FIFO)', async () => {
    const invoice = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2025-01-15',
      taxRateId,
      lines: [{ productId: widgetId, quantity: '15', unitPrice: '10', taxable: true }],
    });
    expect(invoice.status).toBe(201);
    invoiceId = invoice.body.id;
    const posted = await post(`/api/v1/invoices/${invoiceId}/post`, {
      idempotencyKey: 'golden-t3',
    });
    expect(posted.status).toBe(200);

    const detail = await get(`/api/v1/invoices/${invoiceId}`);
    expect(detail.body.subtotal).toBe('150.00');
    expect(detail.body.taxTotal).toBe('12.38'); // 12.375 rounds half-up
    expect(detail.body.total).toBe('162.38');

    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-01-15');
    expect(tbRow(tb.body, 'Accounts Receivable')!.debit).toBe('162.38');
    expect(tbRow(tb.body, 'Sales Tax Payable')!.credit).toBe('12.38');
    expect(tbRow(tb.body, 'Cost of Goods Sold')!.debit).toBe('95.00');
    expect(tbRow(tb.body, 'Inventory Asset')!.debit).toBe('35.00');
    expect(tbRow(tb.body, 'Service Income')!.credit).toBe('150.00');
  });

  it('T4 partial customer payment: $100 to Undeposited Funds, allocated', async () => {
    const res = await post('/api/v1/payments', {
      customerId,
      paymentDate: '2025-01-20',
      amount: '100',
      depositToAccountId: ufId,
      allocations: [{ invoiceId, amount: '100' }],
      idempotencyKey: 'golden-t4',
    });
    expect(res.status).toBe(201);
    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.openBalance).toBe('62.38');
  });

  it('T5 grouped deposit: Dr Bank 100 / Cr Undeposited Funds 100', async () => {
    const undeposited = await get('/api/v1/undeposited-receipts');
    expect(undeposited.body.items.length).toBe(1);
    const res = await post('/api/v1/deposits', {
      depositDate: '2025-01-25',
      bankAccountId: checkingId,
      receipts: [
        {
          sourceType: undeposited.body.items[0].sourceType,
          sourceId: undeposited.body.items[0].sourceId,
        },
      ],
      idempotencyKey: 'golden-t5',
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe('100.00');
  });

  it('T6 partial bill payment: $80 -> Dr AP / Cr Bank; bill open = 50', async () => {
    const res = await post('/api/v1/bill-payments', {
      vendorId,
      paymentDate: '2025-01-28',
      bankAccountId: checkingId,
      allocations: [{ billId, amount: '80' }],
      idempotencyKey: 'golden-t6',
    });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe('80.00');
    const bill = await get(`/api/v1/bills/${billId}`);
    expect(bill.body.openBalance).toBe('50.00');
  });
});

describe('golden dataset expected results (as of 2025-01-31)', () => {
  it('every authoritative balance matches exactly', async () => {
    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    expect(tbRow(tb.body, 'Checking')!.debit).toBe('10020.00');
    expect(tbRow(tb.body, 'Accounts Receivable')!.debit).toBe('62.38');
    expect(tbRow(tb.body, 'Inventory Asset')!.debit).toBe('35.00');
    expect(tbRow(tb.body, 'Accounts Payable')!.credit).toBe('50.00');
    expect(tbRow(tb.body, 'Sales Tax Payable')!.credit).toBe('12.38');
    expect(tbRow(tb.body, 'Service Income')!.credit).toBe('150.00');
    expect(tbRow(tb.body, 'Cost of Goods Sold')!.debit).toBe('95.00');
    expect(tbRow(tb.body, 'Undeposited Funds')).toBeUndefined();
    expect(tb.body.totalDebits).toBe(tb.body.totalCredits);
  });

  it('P&L: revenue 150, COGS 95, net income 55', async () => {
    const pl = await get('/api/v1/reports/profit-and-loss?startDate=2025-01-01&endDate=2025-01-31');
    expect(pl.body.income.total).toBe('150.00');
    expect(pl.body.cogs.total).toBe('95.00');
    expect(pl.body.grossProfit).toBe('55.00');
    expect(pl.body.netIncome).toBe('55.00');
  });

  it('Balance sheet: assets 10,117.38 = liabilities + equity', async () => {
    const bs = await get('/api/v1/reports/balance-sheet?asOf=2025-01-31');
    expect(bs.body.totalAssets).toBe('10117.38');
    expect(bs.body.totalLiabilitiesAndEquity).toBe('10117.38');
    expect(bs.body.balanced).toBe(true);
  });

  it('AR aging = 62.38 and AP aging = 50, both tie to control accounts', async () => {
    const ar = await get('/api/v1/reports/ar-aging?asOf=2025-01-31');
    expect(ar.body.total).toBe('62.38');
    expect(ar.body.tiesToControl).toBe(true);
    const ap = await get('/api/v1/reports/ap-aging?asOf=2025-01-31');
    expect(ap.body.total).toBe('50.00');
    expect(ap.body.tiesToControl).toBe(true);
  });

  it('Inventory GL balance equals FIFO remaining layer value (qty 5, $35)', async () => {
    const { getDb } = await import('@server/db/client');
    const { inventoryOnHand } = await import('@server/accounting/inventory');
    const onHand = await getDb().transaction((tx) => inventoryOnHand(tx, orgId, widgetId));
    expect(onHand.quantity).toBe('5');
    expect(onHand.value).toBe('35.00');
  });

  it('replaying any golden command changes nothing', async () => {
    const tbBefore = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    const replay = await post('/api/v1/bill-payments', {
      vendorId,
      paymentDate: '2025-01-28',
      bankAccountId: checkingId,
      allocations: [{ billId, amount: '80' }],
      idempotencyKey: 'golden-t6',
    });
    expect(replay.status).toBe(201);
    const tbAfter = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    expect(tbAfter.body).toEqual(tbBefore.body);
  });

  it('a ledger rebuild reproduces identical entry hashes', async () => {
    const { getDb, getPool } = await import('@server/db/client');
    void getDb;
    const { createHash } = await import('node:crypto');
    const { canonicalJson } = await import('@server/accounting/audit');
    const pool = getPool();
    const entries = await pool.query(
      `SELECT id, lines_hash FROM journal_entries WHERE organization_id = $1`,
      [orgId],
    );
    for (const entry of entries.rows) {
      const lines = await pool.query(
        `SELECT account_id, debit::text AS debit, credit::text AS credit
         FROM journal_lines WHERE entry_id = $1 ORDER BY line_number`,
        [entry.id],
      );
      const recomputed = createHash('sha256')
        .update(
          canonicalJson(
            lines.rows.map((l: { account_id: string; debit: string; credit: string }) => ({
              a: l.account_id,
              d: l.debit,
              c: l.credit,
            })),
          ),
        )
        .digest('hex');
      expect(recomputed).toBe(entry.lines_hash);
    }
    expect(entries.rows.length).toBeGreaterThanOrEqual(6);
  });
});

describe('isolated void fixture with confirmed physical return', () => {
  it('voiding an unpaid inventory invoice restores stock and reverses everything', async () => {
    const before = await get('/api/v1/reports/trial-balance?asOf=2025-02-28');
    const { getDb } = await import('@server/db/client');
    const { inventoryOnHand } = await import('@server/accounting/inventory');
    const beforeStock = await getDb().transaction((tx) => inventoryOnHand(tx, orgId, widgetId));

    const invoice = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2025-02-10',
      taxRateId,
      lines: [{ productId: widgetId, quantity: '2', unitPrice: '10', taxable: true }],
    });
    await post(`/api/v1/invoices/${invoice.body.id}/post`, { idempotencyKey: 'void-fx-1' });

    // Without confirmation the void is refused with guidance.
    const refused = await post(`/api/v1/invoices/${invoice.body.id}/void`, {
      idempotencyKey: 'void-fx-2',
      reason: 'customer cancelled, goods returned',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('INVENTORY_RETURN_CONFIRMATION_REQUIRED');

    const voided = await post(`/api/v1/invoices/${invoice.body.id}/void`, {
      idempotencyKey: 'void-fx-3',
      reason: 'customer cancelled, goods returned',
      confirmInventoryReturn: true,
    });
    expect(voided.status).toBe(200);

    const after = await get('/api/v1/reports/trial-balance?asOf=2025-02-28');
    expect(after.body).toEqual(before.body);
    const afterStock = await getDb().transaction((tx) => inventoryOnHand(tx, orgId, widgetId));
    expect(afterStock).toEqual(beforeStock);
  });
});
