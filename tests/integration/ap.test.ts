import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, identity, resetDatabase } from './helpers';

let app: Express;
let orgId: string;
let vendorId: string;
let suppliesAccountId: string;
let checkingId: string;
let cardAccountId: string;

const approver = identity('approver@example.test', 'Avery Approver');

async function post(url: string, body: unknown, as = OWNER) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(as))
    .send(body as object);
}
async function get(url: string, as = OWNER) {
  return request(app).get(url).set('x-test-auth', authHeader(as));
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  orgId = await bootstrapCompany(app, 'AP Test Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  const db = getDb();
  await db.transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  // Approval threshold: bills at or above $500 need approval.
  const { purchasingSettings } = await import('@server/db/schema/index');
  const { eq } = await import('drizzle-orm');
  await db
    .update(purchasingSettings)
    .set({ billApprovalThreshold: '500' })
    .where(eq(purchasingSettings.organizationId, orgId));

  const accounts = await get('/api/v1/accounts');
  suppliesAccountId = accounts.body.items.find(
    (a: { name: string }) => a.name === 'Office Supplies & Software',
  ).id;
  checkingId = accounts.body.items.find((a: { name: string }) => a.name === 'Checking').id;
  cardAccountId = accounts.body.items.find(
    (a: { name: string }) => a.name === 'Business Credit Card',
  ).id;

  const vendor = await post('/api/v1/vendors', { displayName: 'Paper Planet', termsDays: 15 });
  vendorId = vendor.body.id;

  // Invite an accountant who can approve bills.
  const roles = await get('/api/v1/roles');
  const accountantRole = roles.body.items.find((r: { key: string }) => r.key === 'accountant');
  const invite = await post('/api/v1/invitations', {
    email: approver.email,
    roleId: accountantRole.id,
  });
  const token = new URL(invite.body.inviteUrl).searchParams.get('token')!;
  await post('/api/v1/invitations/accept', { token }, approver);
});

describe('bill approval and separation of duties', () => {
  let bigBillId: string;

  it('bills at/above the threshold require approval; small bills do not', async () => {
    const small = await post('/api/v1/bills', {
      vendorId,
      billDate: '2025-03-01',
      lines: [{ accountId: suppliesAccountId, amount: '100' }],
    });
    expect(small.body.approvalRequired).toBe(false);

    const big = await post('/api/v1/bills', {
      vendorId,
      billDate: '2025-03-02',
      lines: [{ accountId: suppliesAccountId, amount: '900', description: 'Annual software' }],
    });
    expect(big.body.approvalRequired).toBe(true);
    bigBillId = big.body.id;

    const blocked = await post(`/api/v1/bills/${bigBillId}/post`, {
      idempotencyKey: 'bill-appr-1',
    });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('the creator cannot approve their own bill', async () => {
    const res = await post(`/api/v1/bills/${bigBillId}/approve`, {});
    expect(res.status).toBe(403);
  });

  it('a different authorized member approves; the bill posts to AP', async () => {
    const approved = await post(`/api/v1/bills/${bigBillId}/approve`, {}, approver);
    expect(approved.status).toBe(200);
    const posted = await post(`/api/v1/bills/${bigBillId}/post`, { idempotencyKey: 'bill-appr-2' });
    expect(posted.status).toBe(200);
    const ap = await get('/api/v1/reports/ap-aging?asOf=2025-03-31');
    expect(ap.body.tiesToControl).toBe(true);
  });

  it('rejection requires a reason and returns the bill to an editable state', async () => {
    const bill = await post('/api/v1/bills', {
      vendorId,
      billDate: '2025-03-05',
      lines: [{ accountId: suppliesAccountId, amount: '700' }],
    });
    const noReason = await post(`/api/v1/bills/${bill.body.id}/reject`, {}, approver);
    expect(noReason.status).toBe(400);
    const rejected = await post(
      `/api/v1/bills/${bill.body.id}/reject`,
      { reason: 'Wrong vendor, resubmit' },
      approver,
    );
    expect(rejected.status).toBe(200);
    const blocked = await post(`/api/v1/bills/${bill.body.id}/post`, {
      idempotencyKey: 'bill-rej-1',
    });
    expect(blocked.status).toBe(422);
  });
});

describe('purchase-to-pay', () => {
  let billId: string;

  it('posts a bill and pays it partially across the workflow', async () => {
    const bill = await post('/api/v1/bills', {
      vendorId,
      billDate: '2025-04-01',
      lines: [
        { accountId: suppliesAccountId, amount: '300', description: 'Paper' },
        { accountId: suppliesAccountId, amount: '100', description: 'Toner' },
      ],
    });
    billId = bill.body.id;
    await post(`/api/v1/bills/${billId}/post`, { idempotencyKey: 'p2p-0001' });

    const over = await post('/api/v1/bill-payments', {
      vendorId,
      paymentDate: '2025-04-10',
      bankAccountId: checkingId,
      allocations: [{ billId, amount: '999' }],
      idempotencyKey: 'p2p-0002',
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVER_APPLICATION');

    const pay = await post('/api/v1/bill-payments', {
      vendorId,
      paymentDate: '2025-04-10',
      bankAccountId: checkingId,
      allocations: [{ billId, amount: '250' }],
      idempotencyKey: 'p2p-0003',
    });
    expect(pay.status).toBe(201);
    const detail = await get(`/api/v1/bills/${billId}`);
    expect(detail.body.openBalance).toBe('150.00');
  });

  it('vendor credits reverse the original treatment and apply to bills', async () => {
    const credit = await post('/api/v1/vendor-credits', {
      vendorId,
      creditDate: '2025-04-12',
      lines: [{ accountId: suppliesAccountId, amount: '60', description: 'Returned toner' }],
    });
    await post(`/api/v1/vendor-credits/${credit.body.id}/post`, { idempotencyKey: 'vc-000001' });
    const applied = await post(`/api/v1/vendor-credits/${credit.body.id}/apply`, {
      allocations: [{ billId, amount: '60' }],
      effectiveDate: '2025-04-12',
      idempotencyKey: 'vc-000002',
    });
    expect(applied.status).toBe(200);
    const detail = await get(`/api/v1/bills/${billId}`);
    expect(detail.body.openBalance).toBe('90.00');
    const ap = await get('/api/v1/reports/ap-aging?asOf=2025-04-30');
    expect(ap.body.tiesToControl).toBe(true);
  });

  it('card purchases hit the card liability; expense void reverses exactly', async () => {
    const tbBefore = await get('/api/v1/reports/trial-balance?asOf=2025-05-31');
    const expense = await post('/api/v1/expenses', {
      payeeName: 'Fuel Stop',
      expenseDate: '2025-05-02',
      paymentAccountId: cardAccountId,
      method: 'card',
      lines: [{ accountId: suppliesAccountId, amount: '45.67' }],
      idempotencyKey: 'exp-0001',
    });
    expect(expense.status).toBe(201);
    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-05-31');
    const card = tb.body.rows.find((r: { name: string }) => r.name === 'Business Credit Card');
    expect(card.credit).toBe('45.67');

    const voided = await post(`/api/v1/expenses/${expense.body.id}/void`, {
      idempotencyKey: 'exp-0002',
      reason: 'personal purchase entered by mistake',
    });
    expect(voided.status).toBe(200);
    const tbAfter = await get('/api/v1/reports/trial-balance?asOf=2025-05-31');
    expect(tbAfter.body).toEqual(tbBefore.body);
  });

  it('permissions: a bill clerk cannot approve, post, or pay', async () => {
    const clerk = identity('clerk@example.test', 'Casey Clerk');
    const roles = await get('/api/v1/roles');
    const clerkRole = roles.body.items.find((r: { key: string }) => r.key === 'bill_clerk');
    const invite = await post('/api/v1/invitations', { email: clerk.email, roleId: clerkRole.id });
    const token = new URL(invite.body.inviteUrl).searchParams.get('token')!;
    await post('/api/v1/invitations/accept', { token }, clerk);

    const draft = await post(
      '/api/v1/bills',
      {
        vendorId,
        billDate: '2025-05-10',
        lines: [{ accountId: suppliesAccountId, amount: '20' }],
      },
      clerk,
    );
    expect(draft.status).toBe(201);

    const approveDenied = await post(`/api/v1/bills/${draft.body.id}/approve`, {}, clerk);
    expect(approveDenied.status).toBe(403);
    const postDenied = await post(
      `/api/v1/bills/${draft.body.id}/post`,
      { idempotencyKey: 'clerk-01' },
      clerk,
    );
    expect(postDenied.status).toBe(403);
    const payDenied = await post(
      '/api/v1/bill-payments',
      {
        vendorId,
        paymentDate: '2025-05-11',
        bankAccountId: checkingId,
        allocations: [{ billId: draft.body.id, amount: '20' }],
        idempotencyKey: 'clerk-02',
      },
      clerk,
    );
    expect(payDenied.status).toBe(403);
  });
});
