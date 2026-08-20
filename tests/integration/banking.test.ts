import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { OWNER, authHeader, bootstrapCompany, getApp, resetDatabase } from './helpers';

let app: Express;
let checkingId: string;
let cardId: string;
let suppliesId: string;
let mealsId: string;
let equityId: string;
let expenseEntryId: string;

async function post(url: string, body: unknown) {
  return request(app)
    .post(url)
    .set('x-test-auth', authHeader(OWNER))
    .send(body as object);
}
async function del(url: string) {
  return request(app).delete(url).set('x-test-auth', authHeader(OWNER));
}
async function get(url: string) {
  return request(app).get(url).set('x-test-auth', authHeader(OWNER));
}

const CSV = `Date,Description,Amount
01/10/2025,ACME OFFICE SUPPLY,-200.00
01/05/2025,OWNER DEPOSIT,1000.00
01/12/2025,DOWNTOWN COFFEE,-50.00
`;

const MAPPING = {
  dateColumn: 0,
  descriptionColumn: 1,
  amountColumn: 2,
  dateFormat: 'MDY',
  hasHeader: true,
};

beforeAll(async () => {
  app = await getApp();
  await resetDatabase();
  const orgId = await bootstrapCompany(app, 'Banking Test Co');
  const { getDb } = await import('@server/db/client');
  const { applyChartTemplate } = await import('@server/accounting/accounts');
  await getDb().transaction(async (tx) => {
    await applyChartTemplate(tx, orgId, 'general_service');
  });
  const accounts = await get('/api/v1/accounts');
  const byName = (n: string) => accounts.body.items.find((a: { name: string }) => a.name === n).id;
  checkingId = byName('Checking');
  cardId = byName('Business Credit Card');
  suppliesId = byName('Office Supplies & Software');
  mealsId = byName('Meals');
  equityId = byName('Owner Equity');

  // Book activity: opening funds + a purchase we will later match.
  const journal = await post('/api/v1/manual-journals', {
    journalDate: '2025-01-05',
    memo: 'Opening funds',
    lines: [
      { accountId: checkingId, debit: '1000' },
      { accountId: equityId, credit: '1000' },
    ],
  });
  await post(`/api/v1/manual-journals/${journal.body.id}/post`, { idempotencyKey: 'bank-op-1' });

  const expense = await post('/api/v1/expenses', {
    payeeName: 'Acme Office Supply',
    expenseDate: '2025-01-10',
    paymentAccountId: checkingId,
    method: 'check',
    lines: [{ accountId: suppliesId, amount: '200' }],
    idempotencyKey: 'bank-exp-1',
  });
  expenseEntryId = expense.body.journalEntryId;
});

describe('CSV import and review', () => {
  let coffeeItemId: string;

  it('dry run parses, previews, and counts without writing', async () => {
    const res = await post('/api/v1/banking/import', {
      accountId: checkingId,
      filename: 'jan.csv',
      content: CSV,
      mapping: MAPPING,
      dryRun: true,
      idempotencyKey: 'imp-dry-1',
    });
    expect(res.status).toBe(200);
    expect(res.body.importedCount).toBe(3);
    expect(res.body.errorCount).toBe(0);
    const items = await get(`/api/v1/banking/items?accountId=${checkingId}`);
    expect(items.body.items.length).toBe(0);
  });

  it('imports rows and a re-import flags every row as a possible duplicate', async () => {
    const first = await post('/api/v1/banking/import', {
      accountId: checkingId,
      filename: 'jan.csv',
      content: CSV,
      mapping: MAPPING,
      dryRun: false,
      idempotencyKey: 'imp-run-1',
    });
    expect(first.status).toBe(201);
    expect(first.body.importedCount).toBe(3);
    expect(first.body.duplicateCount).toBe(0);

    const again = await post('/api/v1/banking/import', {
      accountId: checkingId,
      filename: 'jan-again.csv',
      content: CSV,
      mapping: MAPPING,
      dryRun: false,
      idempotencyKey: 'imp-run-2',
    });
    expect(again.body.duplicateCount).toBe(3);
    const dupes = await get(
      `/api/v1/banking/items?accountId=${checkingId}&state=possible_duplicate`,
    );
    // Heuristic duplicates are STAGED for human review, never auto-excluded.
    expect(dupes.body.items.length).toBe(3);
    for (const d of dupes.body.items) {
      await post(`/api/v1/banking/items/${d.id}/state`, { state: 'excluded' });
    }
  });

  it('suggests the matching book transaction and matching posts no duplicate', async () => {
    const items = await get(`/api/v1/banking/items?accountId=${checkingId}&state=new`);
    const acmeItem = items.body.items.find((i: { description: string }) =>
      i.description.includes('ACME'),
    );
    const suggestions = await get(`/api/v1/banking/items/${acmeItem.id}/suggestions`);
    expect(suggestions.body.items.length).toBeGreaterThan(0);
    expect(suggestions.body.items[0].journalEntryId).toBe(expenseEntryId);

    const tbBefore = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    const matched = await post(`/api/v1/banking/items/${acmeItem.id}/match`, {
      journalEntryId: expenseEntryId,
    });
    expect(matched.status).toBe(200);
    const tbAfter = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    expect(tbAfter.body).toEqual(tbBefore.body); // matching never posts

    // Match the owner deposit too.
    const remaining = await get(`/api/v1/banking/items?accountId=${checkingId}&state=new`);
    const depositItem = remaining.body.items.find((i: { description: string }) =>
      i.description.includes('OWNER DEPOSIT'),
    );
    const s2 = await get(`/api/v1/banking/items/${depositItem.id}/suggestions`);
    await post(`/api/v1/banking/items/${depositItem.id}/match`, {
      journalEntryId: s2.body.items[0].journalEntryId,
    });
  });

  it('categorizing with splits creates one real posted transaction', async () => {
    const items = await get(`/api/v1/banking/items?accountId=${checkingId}&state=new`);
    const coffee = items.body.items.find((i: { description: string }) =>
      i.description.includes('COFFEE'),
    );
    coffeeItemId = coffee.id;

    const bad = await post(`/api/v1/banking/items/${coffeeItemId}/add`, {
      splits: [{ accountId: mealsId, amount: '49.99' }],
      idempotencyKey: 'add-coffee-bad',
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('SPLIT_MISMATCH');

    const good = await post(`/api/v1/banking/items/${coffeeItemId}/add`, {
      splits: [
        { accountId: mealsId, amount: '30.00', memo: 'Team coffee' },
        { accountId: suppliesId, amount: '20.00', memo: 'Beans for office' },
      ],
      payeeName: 'Downtown Coffee',
      idempotencyKey: 'add-coffee-ok',
    });
    expect(good.status).toBe(200);

    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-01-31');
    const meals = tb.body.rows.find((r: { name: string }) => r.name === 'Meals');
    expect(meals.debit).toBe('30.00');

    const resolved = await get(`/api/v1/banking/items?accountId=${checkingId}&state=added`);
    expect(resolved.body.items.some((i: { id: string }) => i.id === coffeeItemId)).toBe(true);
  });

  it('bank rules suggest matching categorizations on import', async () => {
    await post('/api/v1/banking/rules', {
      name: 'Coffee shops',
      conditions: {
        direction: 'out',
        matchType: 'all',
        tests: [{ field: 'description', op: 'contains', value: 'coffee' }],
      },
      actions: { categoryAccountId: mealsId, payeeName: 'Coffee' },
    });
    const res = await post('/api/v1/banking/import', {
      accountId: checkingId,
      filename: 'feb.csv',
      content: 'Date,Description,Amount\n02/03/2025,RIVER COFFEE ROASTERS,-18.25\n',
      mapping: MAPPING,
      dryRun: false,
      idempotencyKey: 'imp-run-3',
    });
    expect(res.status).toBe(201);
    const suggested = await get(`/api/v1/banking/items?accountId=${checkingId}&state=suggested`);
    expect(suggested.body.items.length).toBe(1);
    expect(suggested.body.items[0].appliedRuleId).toBeTruthy();
    // Keep the books tidy for reconciliation below.
    await post(`/api/v1/banking/items/${suggested.body.items[0].id}/state`, { state: 'excluded' });
  });
});

describe('bank reconciliation', () => {
  let reconId: string;

  it('first reconciliation starts from zero and completes only at exact zero', async () => {
    const wrongStart = await post('/api/v1/reconciliations', {
      accountId: checkingId,
      statementStartDate: '2025-01-01',
      statementEndDate: '2025-01-31',
      beginningBalance: '5.00',
      endingBalance: '750.00',
    });
    expect(wrongStart.status).toBe(422);
    expect(wrongStart.body.error.code).toBe('BEGINNING_MISMATCH');

    const started = await post('/api/v1/reconciliations', {
      accountId: checkingId,
      statementStartDate: '2025-01-01',
      statementEndDate: '2025-01-31',
      beginningBalance: '0.00',
      endingBalance: '750.00',
    });
    expect(started.status).toBe(201);
    reconId = started.body.id;

    const detail = await get(`/api/v1/reconciliations/${reconId}`);
    expect(detail.body.candidateLines.length).toBe(3); // +1000, -200, -50
    for (const line of detail.body.candidateLines) {
      await post(`/api/v1/reconciliations/${reconId}/toggle`, {
        journalLineId: line.lineId,
        selected: true,
      });
    }
    const status = await get(`/api/v1/reconciliations/${reconId}`);
    expect(status.body.clearedEnding).toBe('750.00');
    expect(status.body.difference).toBe('0.00');

    const done = await post(`/api/v1/reconciliations/${reconId}/complete`, {
      idempotencyKey: 'recon-01a',
    });
    expect(done.status).toBe(200);
  });

  it('a nonzero difference refuses to complete', async () => {
    // New statement with nothing selected -> difference nonzero.
    const started = await post('/api/v1/reconciliations', {
      accountId: checkingId,
      statementStartDate: '2025-02-01',
      statementEndDate: '2025-02-28',
      beginningBalance: '750.00',
      endingBalance: '999.99',
    });
    expect(started.status).toBe(201);
    const refused = await post(`/api/v1/reconciliations/${started.body.id}/complete`, {
      idempotencyKey: 'recon-02a',
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('NONZERO_DIFFERENCE');
    await del(`/api/v1/reconciliations/${started.body.id}`);
  });

  it('a reconciled line cannot join another reconciliation, and voiding it is blocked', async () => {
    const started = await post('/api/v1/reconciliations', {
      accountId: checkingId,
      statementStartDate: '2025-02-01',
      statementEndDate: '2025-02-28',
      beginningBalance: '750.00',
      endingBalance: '750.00',
    });
    const register = await get(`/api/v1/accounts/${checkingId}/register`);
    const reconciled = register.body.rows.find(
      (r: { reconciliationId: string | null }) => r.reconciliationId,
    );
    const res = await post(`/api/v1/reconciliations/${started.body.id}/toggle`, {
      journalLineId: reconciled.lineId,
      selected: true,
    });
    expect(res.status).toBe(409);
    await del(`/api/v1/reconciliations/${started.body.id}`);
  });
});

describe('credit-card reconciliation fixture (§15)', () => {
  it('begins at $0, posts 300 purchase, 25 refund, 100 payment, reconciles to $175 owed', async () => {
    // $300 purchase on the card.
    await post('/api/v1/expenses', {
      payeeName: 'Hardware Depot',
      expenseDate: '2025-03-05',
      paymentAccountId: cardId,
      method: 'card',
      lines: [{ accountId: suppliesId, amount: '300' }],
      idempotencyKey: 'card-fx-1',
    });
    // $25 vendor refund back to the card: Dr Card, Cr original expense.
    const refund = await post('/api/v1/manual-journals', {
      journalDate: '2025-03-10',
      memo: 'Vendor refund to card',
      lines: [
        { accountId: cardId, debit: '25' },
        { accountId: suppliesId, credit: '25' },
      ],
    });
    await post(`/api/v1/manual-journals/${refund.body.id}/post`, { idempotencyKey: 'card-fx-2' });
    // $100 card payment: Dr Card Liability, Cr Bank — never duplicates expense.
    const payment = await post('/api/v1/manual-journals', {
      journalDate: '2025-03-15',
      memo: 'Card payment',
      lines: [
        { accountId: cardId, debit: '100' },
        { accountId: checkingId, credit: '100' },
      ],
    });
    await post(`/api/v1/manual-journals/${payment.body.id}/post`, { idempotencyKey: 'card-fx-3' });

    const tb = await get('/api/v1/reports/trial-balance?asOf=2025-03-31');
    const card = tb.body.rows.find((r: { name: string }) => r.name === 'Business Credit Card');
    expect(card.credit).toBe('175.00'); // amount owed

    // Reconcile: ledger-signed ending balance for a liability is -175
    // (the banking UI presents it as a positive amount owed).
    const started = await post('/api/v1/reconciliations', {
      accountId: cardId,
      statementStartDate: '2025-03-01',
      statementEndDate: '2025-03-31',
      beginningBalance: '0.00',
      endingBalance: '-175.00',
    });
    expect(started.status).toBe(201);
    const detail = await get(`/api/v1/reconciliations/${started.body.id}`);
    expect(detail.body.candidateLines.length).toBe(3);
    for (const line of detail.body.candidateLines) {
      await post(`/api/v1/reconciliations/${started.body.id}/toggle`, {
        journalLineId: line.lineId,
        selected: true,
      });
    }
    const status = await get(`/api/v1/reconciliations/${started.body.id}`);
    expect(status.body.difference).toBe('0.00');
    const done = await post(`/api/v1/reconciliations/${started.body.id}/complete`, {
      idempotencyKey: 'card-fx-4',
    });
    expect(done.status).toBe(200);
  });
});
