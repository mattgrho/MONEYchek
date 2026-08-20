import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let customerId: string;

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

function item(body: { items: { key: string; status: string; detail: string }[] }, key: string) {
  const found = body.items.find((i) => i.key === key);
  expect(found, `checklist item ${key}`).toBeDefined();
  return found!;
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Close Checklist Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const customer = await post('/api/v1/customers', { displayName: 'Checklist Customer' });
  customerId = customer.body.id;
});

describe('pre-close checklist', () => {
  it('reports ready with all tie-outs passing on clean books', async () => {
    const res = await get('/api/v1/periods/close-checklist?through=2026-03-31');
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(item(res.body, 'trial_balance').status).toBe('pass');
    expect(item(res.body, 'ar_tie_out').status).toBe('pass');
    expect(item(res.body, 'ap_tie_out').status).toBe('pass');
    expect(item(res.body, 'draft_documents').status).toBe('pass');
    expect(item(res.body, 'undeposited_funds').status).toBe('pass');
  });

  it('flags draft documents dated in the period as review items, not failures', async () => {
    const draft = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2026-03-15',
      lines: [{ description: 'Unposted work', quantity: '1', unitPrice: '250' }],
    });
    expect(draft.status).toBe(201);

    const res = await get('/api/v1/periods/close-checklist?through=2026-03-31');
    expect(res.status).toBe(200);
    const drafts = item(res.body, 'draft_documents');
    expect(drafts.status).toBe('warning');
    expect(drafts.detail).toContain('1 draft document');
    // Warnings never block readiness.
    expect(res.body.ready).toBe(true);

    // A checklist dated before the draft goes back to passing.
    const earlier = await get('/api/v1/periods/close-checklist?through=2026-02-28');
    expect(item(earlier.body, 'draft_documents').status).toBe('pass');
  });

  it('flags Undeposited Funds held at the close date', async () => {
    // Post the draft and receive payment into Undeposited Funds.
    const invoices = await get('/api/v1/invoices');
    const inv = invoices.body.items[0];
    const posted = await post(`/api/v1/invoices/${inv.id}/post`, {
      idempotencyKey: 'close-check-post-01',
    });
    expect(posted.status).toBe(200);

    const accounts = await get('/api/v1/accounts');
    const uf = accounts.body.items.find(
      (a: { systemKey: string | null }) => a.systemKey === 'undeposited_funds',
    );
    const payment = await post('/api/v1/payments', {
      customerId,
      paymentDate: '2026-03-20',
      amount: '250.00',
      depositToAccountId: uf.id,
      autoApply: true,
      idempotencyKey: 'close-check-pay-01',
    });
    expect(payment.status).toBe(201);

    const res = await get('/api/v1/periods/close-checklist?through=2026-03-31');
    const ufItem = item(res.body, 'undeposited_funds');
    expect(ufItem.status).toBe('warning');
    expect(ufItem.detail).toContain('250.00');
    // Tie-outs still pass; readiness is unaffected by warnings.
    expect(item(res.body, 'ar_tie_out').status).toBe('pass');
    expect(res.body.ready).toBe(true);
  });

  it('requires a valid through date', async () => {
    const res = await get('/api/v1/periods/close-checklist?through=March');
    expect(res.status).toBe(400);
  });
});
