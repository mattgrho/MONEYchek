/**
 * Performance fixture + measurement (`npm run perf:seed -- --confirm-perf`).
 *
 * Seeds ~10,000 journal entries (posted invoices, customer payments, bills,
 * bill payments, and expenses spread over 18 months) into the TEST database
 * through the real domain services — the posting engine, idempotency, audit
 * chain, and DB invariants all run exactly as in production — then times the
 * report and aging queries and prints EXPLAIN (ANALYZE, BUFFERS) plans for
 * the hottest SQL so index regressions are visible.
 *
 * Safety guards (all hard failures):
 *  - refuses NODE_ENV=production; forces NODE_ENV=test
 *  - targets TEST_DATABASE_URL only, which must contain "test" and must not
 *    equal DATABASE_URL / MIGRATION_DATABASE_URL (enforced by config/env)
 *  - requires the explicit --confirm-perf flag (it TRUNCATEs the test DB)
 */
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

try {
  if (fs.existsSync('.env')) process.loadEnvFile('.env');
} catch {
  /* no .env */
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('Refusing to run the performance seed with NODE_ENV=production');
}
process.env.NODE_ENV = 'test';
process.env.BOOTSTRAP_OWNER_EMAIL = 'perf-owner@example.test';
process.env.APP_BASE_URL ??= 'http://localhost:5000';

const SCALE = (() => {
  const arg = process.argv.find((a) => a.startsWith('--entries='));
  const n = arg ? Number(arg.split('=')[1]) : 10_000;
  if (!Number.isInteger(n) || n < 100 || n > 50_000) {
    throw new Error('--entries must be an integer between 100 and 50000');
  }
  return n / 10_000;
})();

function count(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}

/** 'YYYY-MM-DD' + N days in UTC. */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate(),
  ).padStart(2, '0')}`;
}

const START = '2025-01-01';
const SPREAD_DAYS = 540; // through mid-2026

async function main(): Promise<void> {
  if (!process.argv.includes('--confirm-perf')) {
    throw new Error(
      'Pass --confirm-perf to run (this TRUNCATEs the TEST database and seeds ~10k entries)',
    );
  }
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set');

  const { getDb, getPool, closeDb } = await import('../server/db/client');
  const schema = await import('../server/db/schema/index');
  const { eq } = await import('drizzle-orm');
  const db = getDb();
  const pool = getPool();

  // Fresh slate (test DB only; the env guards above make this safe).
  const { rows: tableRows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (tableRows.length > 0) {
    await pool.query(
      `TRUNCATE ${tableRows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
  }

  const { performBootstrap } = await import('../server/services/bootstrap');
  const { organizationId } = await performBootstrap(db, {
    identity: {
      authProviderId: 'test|perf-owner@example.test',
      email: 'perf-owner@example.test',
      emailVerified: true,
      name: 'Perf Owner',
    },
    companyName: 'Perf Fixture Co (Test)',
    correlationId: 'perf-seed',
  });

  const [membership] = await db
    .select({ userId: schema.memberships.userId, roleId: schema.memberships.roleId })
    .from(schema.memberships)
    .where(eq(schema.memberships.organizationId, organizationId))
    .limit(1);
  const [role] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.id, membership!.roleId))
    .limit(1);
  const ctx = {
    organizationId,
    userId: membership!.userId,
    membershipId: 'perf-seed',
    roleId: membership!.roleId,
    roleKey: role?.key ?? 'owner',
    roleName: role?.name ?? 'Owner',
    permissions: ['*'],
  };

  const { applyChartTemplate } = await import('../server/accounting/accounts');
  await db.transaction(async (tx) => {
    await applyChartTemplate(tx, organizationId, 'general_service');
  });
  const accounts = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, organizationId));
  const checkingId = accounts.find((a) => a.name === 'Checking')!.id;
  const expenseAccounts = accounts.filter((a) => a.category === 'expense').map((a) => a.id);
  if (expenseAccounts.length === 0) throw new Error('Chart template produced no expense accounts');

  // Parties -----------------------------------------------------------------
  const customerRows = await db
    .insert(schema.customers)
    .values(
      Array.from({ length: 40 }, (_, i) => ({
        organizationId,
        displayName: `Perf Customer ${String(i + 1).padStart(2, '0')}`,
        termsDays: 30,
      })),
    )
    .returning({ id: schema.customers.id });
  const vendorRows = await db
    .insert(schema.vendors)
    .values(
      Array.from({ length: 15 }, (_, i) => ({
        organizationId,
        displayName: `Perf Vendor ${String(i + 1).padStart(2, '0')}`,
      })),
    )
    .returning({ id: schema.vendors.id });
  const customerIds = customerRows.map((r) => r.id);
  const vendorIds = vendorRows.map((r) => r.id);

  const { createInvoiceDraft, postInvoice } = await import('../server/services/invoices');
  const { receiveCustomerPayment } = await import('../server/services/payments');
  const { createAndPostExpense, createBillDraft, postBill, payBills } =
    await import('../server/services/bills');

  const N_INVOICES = count(3000);
  const N_PAYMENTS = Math.min(count(2400), N_INVOICES);
  const N_BILLS = count(1200);
  const N_BILL_PAYMENTS = Math.min(count(900), N_BILLS);
  const N_EXPENSES = count(2500);
  const total = N_INVOICES * 1 + N_PAYMENTS + N_BILLS + N_BILL_PAYMENTS + N_EXPENSES;
  console.log(
    `Seeding ~${total} journal entries (${N_INVOICES} invoices, ${N_PAYMENTS} payments, ` +
      `${N_BILLS} bills, ${N_BILL_PAYMENTS} bill payments, ${N_EXPENSES} expenses)…`,
  );

  const t0 = performance.now();
  let done = 0;
  const tick = () => {
    done++;
    if (done % 1000 === 0) {
      const secs = ((performance.now() - t0) / 1000).toFixed(0);
      console.log(`  ${done}/${total + N_INVOICES + N_BILLS} operations (${secs}s)…`);
    }
  };

  // Invoices (draft + post) -------------------------------------------------
  const invoices: { id: string; customerId: string; total: string; date: string }[] = [];
  for (let i = 0; i < N_INVOICES; i++) {
    const date = addDays(START, i % SPREAD_DAYS);
    const customerId = customerIds[i % customerIds.length]!;
    const amount = String(((i % 37) + 1) * 25);
    const draft = await createInvoiceDraft(db, ctx, {
      customerId,
      invoiceDate: date,
      termsDays: 30,
      lines: [
        { description: `Service block ${i + 1}`, quantity: '1', unitPrice: amount },
        { description: `Materials ${i + 1}`, quantity: '2', unitPrice: String((i % 11) + 5) },
      ],
    });
    tick();
    await postInvoice(db, ctx, draft.id, `perf-inv-${i}-00000001`, 'perf-seed');
    tick();
    const [row] = await db
      .select({ total: schema.invoices.total })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, draft.id))
      .limit(1);
    invoices.push({ id: draft.id, customerId, total: row!.total, date });
  }

  // Payments (pay the first N_PAYMENTS invoices in full) ---------------------
  for (let i = 0; i < N_PAYMENTS; i++) {
    const inv = invoices[i]!;
    await receiveCustomerPayment(
      db,
      ctx,
      {
        customerId: inv.customerId,
        paymentDate: addDays(inv.date, 7),
        amount: inv.total,
        depositToAccountId: checkingId,
        allocations: [{ invoiceId: inv.id, amount: inv.total }],
        idempotencyKey: `perf-pay-${i}-00000001`,
      },
      'perf-seed',
    );
    tick();
  }

  // Bills (draft + post) -----------------------------------------------------
  const bills: { id: string; vendorId: string; total: string; date: string }[] = [];
  for (let i = 0; i < N_BILLS; i++) {
    const date = addDays(START, (i * 3) % SPREAD_DAYS);
    const vendorId = vendorIds[i % vendorIds.length]!;
    const amount = String(((i % 23) + 1) * 15);
    const draft = await createBillDraft(db, ctx, {
      vendorId,
      billDate: date,
      termsDays: 30,
      lines: [
        {
          accountId: expenseAccounts[i % expenseAccounts.length]!,
          description: `Supplies ${i + 1}`,
          amount,
        },
      ],
    });
    tick();
    await postBill(db, ctx, draft.id, `perf-bill-${i}-00000001`, 'perf-seed');
    tick();
    bills.push({ id: draft.id, vendorId, total: amount, date });
  }

  // Bill payments -------------------------------------------------------------
  for (let i = 0; i < N_BILL_PAYMENTS; i++) {
    const bill = bills[i]!;
    await payBills(
      db,
      ctx,
      {
        vendorId: bill.vendorId,
        paymentDate: addDays(bill.date, 10),
        bankAccountId: checkingId,
        allocations: [{ billId: bill.id, amount: `${bill.total}.00` }],
        idempotencyKey: `perf-bp-${i}-00000001`,
      },
      'perf-seed',
    );
    tick();
  }

  // Expenses ------------------------------------------------------------------
  for (let i = 0; i < N_EXPENSES; i++) {
    await createAndPostExpense(
      db,
      ctx,
      {
        vendorId: vendorIds[i % vendorIds.length],
        expenseDate: addDays(START, (i * 5) % SPREAD_DAYS),
        paymentAccountId: checkingId,
        method: 'card',
        lines: [
          {
            accountId: expenseAccounts[i % expenseAccounts.length]!,
            description: `Card purchase ${i + 1}`,
            amount: String(((i % 19) + 1) * 7),
          },
        ],
        idempotencyKey: `perf-exp-${i}-00000001`,
      },
      'perf-seed',
    );
    tick();
  }

  const seedSecs = ((performance.now() - t0) / 1000).toFixed(1);
  const [entryCount] = (
    await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_entries WHERE organization_id = $1`,
      [organizationId],
    )
  ).rows;
  const [lineCount] = (
    await pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM journal_lines WHERE organization_id = $1`,
      [organizationId],
    )
  ).rows;
  console.log(
    `Seeded ${entryCount!.n} journal entries / ${lineCount!.n} journal lines in ${seedSecs}s.`,
  );

  await pool.query('ANALYZE');

  // ---------------------------------------------------------------------------
  // Timings: the real report functions, median of 3 runs.
  // ---------------------------------------------------------------------------
  const { trialBalance, profitAndLoss, balanceSheet, journalReport, accountRegister } =
    await import('../server/reports/financial');
  const { arAging, arControlBalance } = await import('../server/reports/ar');
  const { apAging, apControlBalance } = await import('../server/reports/ap');

  const ASOF = '2026-06-30';
  const timings: { name: string; ms: number }[] = [];
  async function time(name: string, fn: () => Promise<unknown>): Promise<void> {
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = performance.now();
      await fn();
      runs.push(performance.now() - s);
    }
    runs.sort((a, b) => a - b);
    timings.push({ name, ms: runs[1]! });
  }

  await time('trialBalance (as of)', () => trialBalance(db, organizationId, ASOF));
  await time('profitAndLoss (18 months)', () => profitAndLoss(db, organizationId, START, ASOF));
  await time('balanceSheet (as of)', () => balanceSheet(db, organizationId, ASOF, 1));
  await time('arAging (as of)', () => arAging(db, organizationId, ASOF));
  await time('arControlBalance', () => arControlBalance(db, organizationId, ASOF));
  await time('apAging (as of)', () => apAging(db, organizationId, ASOF));
  await time('apControlBalance', () => apControlBalance(db, organizationId, ASOF));
  await time('journalReport (1 month)', () =>
    journalReport(db, organizationId, '2026-01-01', '2026-01-31'),
  );
  await time('accountRegister (checking, full range)', () =>
    accountRegister(db, organizationId, checkingId, {}),
  );

  console.log('\nReport timings (median of 3):');
  for (const t of timings) console.log(`  ${t.name.padEnd(42)} ${t.ms.toFixed(1)} ms`);

  // ---------------------------------------------------------------------------
  // EXPLAIN (ANALYZE, BUFFERS) for the hottest raw SQL. These are copies of
  // the production queries (accountBalances aggregate, AR control balance,
  // paginated invoice list); if the real queries change, update these too —
  // the point is plan/index review, not exact reuse.
  // ---------------------------------------------------------------------------
  const explains: { name: string; sql: string; params: unknown[] }[] = [
    {
      name: 'accountBalances aggregate (trial balance / P&L / BS)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
        SELECT a.id, COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit - l.credit END), 0)
        FROM accounts a
        LEFT JOIN journal_lines l ON l.account_id = a.id
        LEFT JOIN journal_entries e ON e.id = l.entry_id AND e.posting_date <= $2::date
        WHERE a.organization_id = $1
        GROUP BY a.id`,
      params: [organizationId, ASOF],
    },
    {
      name: 'AR control balance (aging tie-out)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
        SELECT COALESCE(SUM(l.debit - l.credit), 0)
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id
        JOIN accounts a ON a.id = l.account_id
        WHERE l.organization_id = $1
          AND a.system_key = 'accounts_receivable'
          AND e.posting_date <= $2::date`,
      params: [organizationId, ASOF],
    },
    {
      name: 'paginated invoice list with open balances (first page)',
      sql: `EXPLAIN (ANALYZE, BUFFERS)
        SELECT i.id,
               (i.total
                 - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                             WHERE pa.invoice_id = i.id), 0)
                 - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                             WHERE ca.invoice_id = i.id), 0)
                 - COALESCE((SELECT SUM(w.amount) FROM invoice_write_offs w
                             WHERE w.invoice_id = i.id AND w.reversal_of_write_off_id IS NULL), 0))
        FROM invoices i
        JOIN customers c ON c.id = i.customer_id
        WHERE i.organization_id = $1
        ORDER BY i.invoice_date DESC, i.number DESC
        LIMIT 101`,
      params: [organizationId],
    },
  ];
  for (const e of explains) {
    console.log(`\nEXPLAIN — ${e.name}:`);
    const { rows } = await pool.query<{ 'QUERY PLAN': string }>(e.sql, e.params);
    for (const row of rows) console.log(`  ${row['QUERY PLAN']}`);
  }

  await closeDb();
  console.log('\nDone. The test database now holds the perf fixture; re-run `npm test` freely —');
  console.log('the integration suite truncates business tables before running.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
