import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import {
  OWNER,
  authHeader,
  bootstrapCompany,
  getApp,
  identity,
  resetDatabase,
  type TestIdentity,
} from './helpers';

let app: Express;
let orgId: string;
let customerId: string;
let vendorId: string;
let checkingId: string;
let suppliesId: string;
let ufId: string;

const APPROVER_B = identity('approver-b@example.test', 'Blair Approver');
const APPROVER_C = identity('approver-c@example.test', 'Casey Approver');

async function as(user: TestIdentity) {
  return {
    post: (url: string, body: unknown) =>
      request(app)
        .post(url)
        .set('x-test-auth', authHeader(user))
        .send(body as object),
    get: (url: string) => request(app).get(url).set('x-test-auth', authHeader(user)),
  };
}
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

async function invite(user: TestIdentity, roleKey: string) {
  const rolesRes = await get('/api/v1/roles');
  const role = rolesRes.body.items.find((r: { key: string }) => r.key === roleKey);
  expect(role, `role ${roleKey}`).toBeTruthy();
  const inviteRes = await post('/api/v1/invitations', { email: user.email, roleId: role.id });
  expect(inviteRes.status).toBe(201);
  const token = new URL(inviteRes.body.inviteUrl).searchParams.get('token')!;
  const accept = await request(app)
    .post('/api/v1/invitations/accept')
    .set('x-test-auth', authHeader(user))
    .send({ token });
  expect(accept.status).toBe(200);
}

async function expectArTies(asOf: string) {
  const res = await get(`/api/v1/reports/ar-aging?asOf=${asOf}`);
  expect(res.status).toBe(200);
  expect(res.body.tiesToControl).toBe(true);
  return res.body;
}

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  orgId = await bootstrapCompany(app, 'Extensions Test Co');
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
  suppliesId = accounts.body.items.find((a: { category: string; systemKey: string | null }) =>
    a.category === 'expense' && a.systemKey === null,
  ).id;

  const customer = await post('/api/v1/customers', { displayName: 'Retainer Customer' });
  customerId = customer.body.id;
  const vendor = await post('/api/v1/vendors', { displayName: 'PO Vendor' });
  vendorId = vendor.body.id;

  await invite(APPROVER_B, 'bill_approver');
  await invite(APPROVER_C, 'bill_approver');
});

/* ---------------------------- Purchase orders ---------------------------- */

describe('purchase orders', () => {
  let poId: string;
  let lineIds: string[];

  it('creates a draft PO with exact line math', async () => {
    const res = await post('/api/v1/purchase-orders', {
      vendorId,
      poDate: '2026-04-01',
      lines: [
        { accountId: suppliesId, description: 'Lumber', quantity: '10', unitCost: '25.50' },
        { accountId: suppliesId, description: 'Fasteners', quantity: '4', unitCost: '12.25' },
      ],
    });
    expect(res.status).toBe(201);
    poId = res.body.id;
    expect(res.body.number).toMatch(/^PO-/);
    const detail = await get(`/api/v1/purchase-orders/${poId}`);
    expect(detail.body.total).toBe('304.00'); // 255.00 + 49.00
    expect(detail.body.status).toBe('draft');
    lineIds = detail.body.lines.map((l: { id: string }) => l.id);
  });

  it('renders a branded PO PDF', async () => {
    const res = await get(`/api/v1/purchase-orders/${poId}/pdf`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
  });

  it('cannot convert a draft; open it first', async () => {
    const res = await post(`/api/v1/purchase-orders/${poId}/convert`, {
      billDate: '2026-04-05',
    });
    expect(res.status).toBe(409);
    const open = await post(`/api/v1/purchase-orders/${poId}/transition`, { to: 'open' });
    expect(open.status).toBe(200);
  });

  it('blocks overbilling on conversion', async () => {
    const res = await post(`/api/v1/purchase-orders/${poId}/convert`, {
      billDate: '2026-04-05',
      selections: [{ poLineId: lineIds[0], quantity: '11' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVERBILLING_BLOCKED');
  });

  it('partially converts to a bill draft and tracks billed quantity', async () => {
    const res = await post(`/api/v1/purchase-orders/${poId}/convert`, {
      billDate: '2026-04-05',
      selections: [{ poLineId: lineIds[0], quantity: '6' }],
    });
    expect(res.status).toBe(201);
    const bill = await get(`/api/v1/bills/${res.body.billId}`);
    expect(bill.body.total).toBe('153.00'); // 6 × 25.50
    expect(bill.body.postingStatus).toBe('draft');
    expect(bill.body.purchaseOrderId).toBe(poId);

    const detail = await get(`/api/v1/purchase-orders/${poId}`);
    expect(detail.body.status).toBe('partially_billed');
    expect(detail.body.bills.length).toBe(1);
    const line = detail.body.lines.find((l: { id: string }) => l.id === lineIds[0]);
    expect(line.billedQuantity).toContain('6');
  });

  it('converts the remainder and becomes fully billed', async () => {
    const res = await post(`/api/v1/purchase-orders/${poId}/convert`, {
      billDate: '2026-04-10',
    });
    expect(res.status).toBe(201);
    const bill = await get(`/api/v1/bills/${res.body.billId}`);
    expect(bill.body.total).toBe('151.00'); // 4 × 25.50 + 4 × 12.25
    const detail = await get(`/api/v1/purchase-orders/${poId}`);
    expect(detail.body.status).toBe('billed');

    // A fully billed PO leaves the convertible states entirely.
    const again = await post(`/api/v1/purchase-orders/${poId}/convert`, {
      billDate: '2026-04-11',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });
});

/* --------------------------- Two-step approvals -------------------------- */

describe('two-step bill approvals', () => {
  let billId: string;

  it('configures threshold and two-step mode', async () => {
    const res = await patch('/api/v1/settings/purchasing', {
      billApprovalThreshold: '100',
      approvalMode: 'two_step',
    });
    expect(res.status).toBe(200);
    const settings = await get('/api/v1/settings/purchasing');
    expect(settings.body.approvalMode).toBe('two_step');
  });

  it('a bill over the threshold needs approval; the creator cannot approve', async () => {
    const res = await post('/api/v1/bills', {
      vendorId,
      billDate: '2026-04-12',
      lines: [{ accountId: suppliesId, description: 'Big order', amount: '250.00' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.approvalRequired).toBe(true);
    billId = res.body.id;

    const selfApprove = await post(`/api/v1/bills/${billId}/approve`, {});
    expect(selfApprove.status).toBe(403);
  });

  it('first approval leaves the bill partially approved and unpostable', async () => {
    const b = await as(APPROVER_B);
    const res = await b.post(`/api/v1/bills/${billId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.approvalStatus).toBe('partially_approved');

    const postRes = await post(`/api/v1/bills/${billId}/post`, {
      idempotencyKey: 'ext-a-bill-post-01',
    });
    expect(postRes.status).toBe(422);
    expect(postRes.body.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('the same approver cannot supply the second approval', async () => {
    const b = await as(APPROVER_B);
    const res = await b.post(`/api/v1/bills/${billId}/approve`, {});
    expect(res.status).toBe(403);
  });

  it('a second, different approver completes approval; posting works', async () => {
    const c = await as(APPROVER_C);
    const res = await c.post(`/api/v1/bills/${billId}/approve`, {});
    expect(res.status).toBe(200);
    expect(res.body.approvalStatus).toBe('approved');

    const detail = await get(`/api/v1/bills/${billId}`);
    expect(detail.body.approvals.length).toBe(2);
    expect(detail.body.approvals.map((a: { step: number }) => a.step)).toEqual([1, 2]);

    const postRes = await post(`/api/v1/bills/${billId}/post`, {
      idempotencyKey: 'ext-a-bill-post-02',
    });
    expect(postRes.status).toBe(200);
  });

  it('one-step mode still approves in a single decision', async () => {
    await patch('/api/v1/settings/purchasing', { approvalMode: 'one_step' });
    const res = await post('/api/v1/bills', {
      vendorId,
      billDate: '2026-04-13',
      lines: [{ accountId: suppliesId, description: 'Second order', amount: '150.00' }],
    });
    const b = await as(APPROVER_B);
    const approve = await b.post(`/api/v1/bills/${res.body.id}/approve`, {});
    expect(approve.status).toBe(200);
    expect(approve.body.approvalStatus).toBe('approved');
    // Turn the threshold back off for the remaining suites.
    await patch('/api/v1/settings/purchasing', { billApprovalThreshold: null });
  });
});

/* ----------------------------- NSF / returns ----------------------------- */

describe('returned (NSF) customer payments', () => {
  let invoiceId: string;
  let paymentId: string;

  it('sets up a paid invoice through Undeposited Funds and a deposit', async () => {
    const inv = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2026-05-01',
      lines: [{ description: 'Project work', quantity: '1', unitPrice: '500' }],
    });
    invoiceId = inv.body.id;
    await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'ext-a-inv-post-01' });

    const pay = await post('/api/v1/payments', {
      customerId,
      paymentDate: '2026-05-05',
      amount: '500.00',
      depositToAccountId: ufId,
      allocations: [{ invoiceId, amount: '500.00' }],
      idempotencyKey: 'ext-a-pay-01',
    });
    expect(pay.status).toBe(201);
    paymentId = pay.body.id;

    const dep = await post('/api/v1/deposits', {
      depositDate: '2026-05-06',
      bankAccountId: checkingId,
      receipts: [{ sourceType: 'customer_payment', sourceId: paymentId }],
      idempotencyKey: 'ext-a-dep-01',
    });
    expect(dep.status).toBe(201);

    const detail = await get(`/api/v1/invoices/${invoiceId}`);
    expect(detail.body.openBalance).toBe('0.00');
    await expectArTies('2026-05-06');
  });

  it('returning the payment reopens the invoice and credits the bank', async () => {
    const res = await post(`/api/v1/payments/${paymentId}/return`, {
      returnDate: '2026-05-10',
      reason: 'NSF — insufficient funds',
      idempotencyKey: 'ext-a-nsf-01',
    });
    expect(res.status).toBe(200);
    const entryId = res.body.returnJournalEntryId;

    const detail = await get(`/api/v1/invoices/${invoiceId}`);
    expect(detail.body.openBalance).toBe('500.00');
    expect(detail.body.settlementStatus).toBe('open');

    // The credit side must hit Checking (where the deposit put the money),
    // not Undeposited Funds.
    const register = await get(
      `/api/v1/accounts/${checkingId}/register?startDate=2026-05-10&endDate=2026-05-10`,
    );
    const returnRow = register.body.rows.find(
      (r: { entryId: string }) => r.entryId === entryId,
    );
    expect(returnRow).toBeTruthy();
    expect(returnRow.credit).toBe('500.00');

    // Aging still ties, and the returned payment offers no credit.
    const aging = await expectArTies('2026-05-10');
    const credits = aging.detail.filter((d: { kind: string }) => d.kind === 'payment_credit');
    expect(credits.length).toBe(0);
  });

  it('is idempotent-guarded: a second return or a void is refused', async () => {
    const again = await post(`/api/v1/payments/${paymentId}/return`, {
      returnDate: '2026-05-11',
      reason: 'duplicate return attempt',
      idempotencyKey: 'ext-a-nsf-02',
    });
    expect(again.status).toBe(409);
    const voided = await post(`/api/v1/payments/${paymentId}/void`, {
      reason: 'trying to void after return',
      idempotencyKey: 'ext-a-nsf-03',
    });
    expect(voided.status).toBe(409);
  });

  it('aging as of a date before the return still shows the invoice paid', async () => {
    const aging = await expectArTies('2026-05-08');
    const openInvoice = aging.detail.find(
      (d: { documentId: string }) => d.documentId === invoiceId,
    );
    expect(openInvoice).toBeUndefined();
  });
});

/* ------------------------------- Retainers ------------------------------- */

describe('customer retainers', () => {
  let retainerId: string;
  let invoiceId: string;
  let applicationId: string;

  it('receives a retainer into the bank and books the liability', async () => {
    const res = await post('/api/v1/retainers', {
      customerId,
      receivedDate: '2026-06-01',
      amount: '1000.00',
      depositToAccountId: checkingId,
      idempotencyKey: 'ext-a-ret-01',
    });
    expect(res.status).toBe(201);
    expect(res.body.number).toMatch(/^RET-/);
    retainerId = res.body.id;

    const detail = await get(`/api/v1/retainers/${retainerId}`);
    expect(detail.body.balance).toBe('1000.00');

    const bs = await get('/api/v1/reports/balance-sheet?asOf=2026-06-01');
    const liability = bs.body.liabilities.rows.find((r: { name: string }) =>
      r.name.includes('Customer Retainers'),
    );
    expect(liability?.amount).toBe('1000.00');
  });

  it('refuses controlled accounts as the deposit target', async () => {
    const res = await post('/api/v1/retainers', {
      customerId,
      receivedDate: '2026-06-01',
      amount: '100.00',
      depositToAccountId: ufId,
      idempotencyKey: 'ext-a-ret-02',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CONTROL_ACCOUNT_PROTECTED');
  });

  it('applies the retainer to an invoice; AR still ties', async () => {
    const inv = await post('/api/v1/invoices', {
      customerId,
      invoiceDate: '2026-06-05',
      lines: [{ description: 'Phase 1', quantity: '1', unitPrice: '600' }],
    });
    invoiceId = inv.body.id;
    await post(`/api/v1/invoices/${invoiceId}/post`, { idempotencyKey: 'ext-a-inv-post-02' });

    const apply = await post(`/api/v1/retainers/${retainerId}/apply`, {
      allocations: [{ invoiceId, amount: '400.00' }],
      effectiveDate: '2026-06-06',
      idempotencyKey: 'ext-a-ret-apply-01',
    });
    expect(apply.status).toBe(200);

    const detail = await get(`/api/v1/invoices/${invoiceId}`);
    expect(detail.body.openBalance).toBe('200.00');
    const retainer = await get(`/api/v1/retainers/${retainerId}`);
    expect(retainer.body.balance).toBe('600.00');
    applicationId = retainer.body.applications[0].id;
    await expectArTies('2026-06-06');
  });

  it('blocks over-application beyond the retainer balance or invoice open amount', async () => {
    const res = await post(`/api/v1/retainers/${retainerId}/apply`, {
      allocations: [{ invoiceId, amount: '700.00' }],
      effectiveDate: '2026-06-07',
      idempotencyKey: 'ext-a-ret-apply-02',
    });
    expect(res.status).toBe(422);
  });

  it('manual journals cannot touch the retainer control account', async () => {
    const accounts = await get('/api/v1/accounts');
    const retainerAccount = accounts.body.items.find(
      (a: { systemKey: string | null }) => a.systemKey === 'customer_retainers',
    );
    expect(retainerAccount).toBeTruthy();
    const journal = await post('/api/v1/manual-journals', {
      journalDate: '2026-06-08',
      memo: 'attempt to touch retainers',
      lines: [
        { accountId: retainerAccount.id, debit: '50' },
        { accountId: checkingId, credit: '50' },
      ],
    });
    const journalId = journal.body.id;
    const posted = await post(`/api/v1/manual-journals/${journalId}/post`, {
      idempotencyKey: 'ext-a-ret-mj-01',
    });
    expect(posted.status).toBe(422);
    expect(posted.body.error.code).toBe('CONTROL_ACCOUNT_PROTECTED');
  });

  it('unapplies with an append-only reversing row', async () => {
    const res = await post(`/api/v1/retainer-applications/${applicationId}/unapply`, {
      effectiveDate: '2026-06-09',
      idempotencyKey: 'ext-a-ret-unapply-01',
    });
    expect(res.status).toBe(200);
    const retainer = await get(`/api/v1/retainers/${retainerId}`);
    expect(retainer.body.balance).toBe('1000.00');
    expect(retainer.body.applications.length).toBe(2);
    const detail = await get(`/api/v1/invoices/${invoiceId}`);
    expect(detail.body.openBalance).toBe('600.00');
    await expectArTies('2026-06-09');

    const again = await post(`/api/v1/retainer-applications/${applicationId}/unapply`, {
      effectiveDate: '2026-06-10',
      idempotencyKey: 'ext-a-ret-unapply-02',
    });
    expect(again.status).toBe(409);
  });

  it('voids only a fully-unapplied retainer', async () => {
    const res = await post(`/api/v1/retainers/${retainerId}/void`, {
      reason: 'Recorded in error',
      idempotencyKey: 'ext-a-ret-void-01',
    });
    expect(res.status).toBe(200);
    const detail = await get(`/api/v1/retainers/${retainerId}`);
    expect(detail.body.postingStatus).toBe('voided');
    const bs = await get('/api/v1/reports/balance-sheet?asOf=2026-06-30');
    const liability = bs.body.liabilities.rows.find((r: { name: string }) =>
      r.name.includes('Customer Retainers'),
    );
    expect(liability).toBeUndefined();
  });
});
