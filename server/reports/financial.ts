import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { add, cmp, neg, roundMoney, sub, sum } from '@shared/money';
import { addDaysISO } from '../lib/dates';

/**
 * Core financial reports. Everything derives from posted journal lines —
 * the general ledger is the single monetary source of truth. All amounts are
 * canonical decimal strings.
 */

const PL_CATEGORIES = [
  'income',
  'contra_income',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
];

export interface AccountBalanceRow {
  accountId: string;
  number: string | null;
  name: string;
  category: string;
  systemKey: string | null;
  /** Signed: debits positive. */
  balance: string;
}

export async function accountBalances(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
  options?: { from?: string; categories?: string[] },
): Promise<AccountBalanceRow[]> {
  const from = options?.from ?? null;
  const categories = options?.categories ?? null;
  const result = await db.execute(sql`
    SELECT a.id AS account_id, a.number, a.name, a.category, a.system_key,
           COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit - l.credit END), 0)::text AS balance
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
    LEFT JOIN journal_entries e ON e.id = l.entry_id
      AND e.posting_date <= ${asOf}::date
      ${from ? sql`AND e.posting_date >= ${from}::date` : sql``}
    WHERE a.organization_id = ${organizationId}
      ${
        categories
          ? sql`AND a.category IN (${sql.join(
              categories.map((c) => sql`${c}`),
              sql`, `,
            )})`
          : sql``
      }
    GROUP BY a.id
    HAVING COALESCE(SUM(CASE WHEN e.id IS NOT NULL THEN l.debit - l.credit END), 0) <> 0
        OR a.active
    ORDER BY a.number NULLS LAST, a.name
  `);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    accountId: r.account_id as string,
    number: r.number as string | null,
    name: r.name as string,
    category: r.category as string,
    systemKey: r.system_key as string | null,
    // The SQL join already restricts to lines with a matching entry; rows
    // with no lines aggregate to 0.
    balance: roundMoney((r.balance as string) ?? '0'),
  }));
}

export interface TrialBalanceReport {
  asOf: string;
  rows: { accountId: string; number: string | null; name: string; debit: string; credit: string }[];
  totalDebits: string;
  totalCredits: string;
}

export async function trialBalance(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
): Promise<TrialBalanceReport> {
  const balances = await accountBalances(db, organizationId, asOf);
  const rows = balances
    .filter((b) => cmp(b.balance, '0') !== 0)
    .map((b) => ({
      accountId: b.accountId,
      number: b.number,
      name: b.name,
      debit: cmp(b.balance, '0') > 0 ? b.balance : '0.00',
      credit: cmp(b.balance, '0') < 0 ? roundMoney(neg(b.balance)) : '0.00',
    }));
  return {
    asOf,
    rows,
    totalDebits: roundMoney(sum(rows.map((r) => r.debit))),
    totalCredits: roundMoney(sum(rows.map((r) => r.credit))),
  };
}

export interface ReportSection {
  label: string;
  rows: { accountId: string; number: string | null; name: string; amount: string }[];
  total: string;
}

export interface ProfitAndLossReport {
  startDate: string;
  endDate: string;
  income: ReportSection;
  cogs: ReportSection;
  grossProfit: string;
  expenses: ReportSection;
  otherIncome: ReportSection;
  otherExpenses: ReportSection;
  netIncome: string;
}

function section(
  label: string,
  balances: AccountBalanceRow[],
  categories: string[],
  sign: 'credit' | 'debit',
): ReportSection {
  const rows = balances
    .filter((b) => categories.includes(b.category) && cmp(b.balance, '0') !== 0)
    .map((b) => ({
      accountId: b.accountId,
      number: b.number,
      name: b.name,
      amount: roundMoney(sign === 'credit' ? neg(b.balance) : b.balance),
    }));
  return { label, rows, total: roundMoney(sum(rows.map((r) => r.amount))) };
}

export async function profitAndLoss(
  db: DbOrTx,
  organizationId: string,
  startDate: string,
  endDate: string,
): Promise<ProfitAndLossReport> {
  const balances = await accountBalances(db, organizationId, endDate, {
    from: startDate,
    categories: PL_CATEGORIES,
  });
  const income = section('Income', balances, ['income', 'contra_income'], 'credit');
  const cogs = section('Cost of goods sold', balances, ['cogs'], 'debit');
  const expenses = section('Expenses', balances, ['expense'], 'debit');
  const otherIncome = section('Other income', balances, ['other_income'], 'credit');
  const otherExpenses = section('Other expenses', balances, ['other_expense'], 'debit');
  const grossProfit = sub(income.total, cogs.total);
  const netIncome = add(
    sub(sub(grossProfit, expenses.total), otherExpenses.total),
    otherIncome.total,
  );
  return {
    startDate,
    endDate,
    income,
    cogs,
    grossProfit: roundMoney(grossProfit),
    expenses,
    otherIncome,
    otherExpenses,
    netIncome: roundMoney(netIncome),
  };
}

/** Net income (credit-positive) over a posting-date range from PL accounts. */
async function netIncomeBetween(
  db: DbOrTx,
  organizationId: string,
  from: string | null,
  to: string,
): Promise<string> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS net
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE l.organization_id = ${organizationId}
      AND a.category IN ('income','contra_income','cogs','expense','other_income','other_expense')
      AND e.posting_date <= ${to}::date
      ${from ? sql`AND e.posting_date >= ${from}::date` : sql``}
  `);
  return (result.rows[0] as { net: string }).net;
}

export function fiscalYearStart(asOf: string, fiscalYearStartMonth: number): string {
  const year = Number.parseInt(asOf.slice(0, 4), 10);
  const month = Number.parseInt(asOf.slice(5, 7), 10);
  const fyYear = month >= fiscalYearStartMonth ? year : year - 1;
  return `${fyYear}-${String(fiscalYearStartMonth).padStart(2, '0')}-01`;
}

export interface BalanceSheetReport {
  asOf: string;
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection & {
    retainedEarnings: string;
    currentYearNetIncome: string;
  };
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

export async function balanceSheet(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
  fiscalYearStartMonth: number,
): Promise<BalanceSheetReport> {
  const balances = await accountBalances(db, organizationId, asOf);
  const assets = section('Assets', balances, ['asset', 'contra_asset'], 'debit');
  const liabilities = section('Liabilities', balances, ['liability'], 'credit');

  const fyStart = fiscalYearStart(asOf, fiscalYearStartMonth);
  const dayBeforeFyStart = addDaysISO(fyStart, -1);
  // Prior years' cumulative net income: strictly before the fiscal year start.
  const priorNetExclusive = await netIncomeBetween(db, organizationId, null, dayBeforeFyStart);
  const currentNet = await netIncomeBetween(db, organizationId, fyStart, asOf);

  const equityRows = balances
    .filter(
      (b) =>
        ['equity', 'contra_equity'].includes(b.category) &&
        b.systemKey !== 'retained_earnings' &&
        cmp(b.balance, '0') !== 0,
    )
    .map((b) => ({
      accountId: b.accountId,
      number: b.number,
      name: b.name,
      amount: roundMoney(neg(b.balance)),
    }));
  const reAccount = balances.find((b) => b.systemKey === 'retained_earnings');
  const retainedEarnings = roundMoney(
    add(reAccount ? neg(reAccount.balance) : '0', priorNetExclusive),
  );
  const currentYearNetIncome = roundMoney(currentNet);
  const equityTotal = roundMoney(
    add(add(sum(equityRows.map((r) => r.amount)), retainedEarnings), currentYearNetIncome),
  );

  const totalAssets = assets.total;
  const totalLiabilitiesAndEquity = roundMoney(add(liabilities.total, equityTotal));
  return {
    asOf,
    assets,
    liabilities,
    equity: {
      label: 'Equity',
      rows: equityRows,
      total: equityTotal,
      retainedEarnings,
      currentYearNetIncome,
    },
    totalAssets,
    totalLiabilitiesAndEquity,
    balanced: cmp(totalAssets, totalLiabilitiesAndEquity) === 0,
  };
}

export interface JournalReportEntry {
  entryId: string;
  entryNumber: number;
  postingDate: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  reversalOfEntryId: string | null;
  lines: {
    lineNumber: number;
    accountId: string;
    accountNumber: string | null;
    accountName: string;
    debit: string;
    credit: string;
    memo: string | null;
  }[];
}

export async function journalReport(
  db: DbOrTx,
  organizationId: string,
  startDate: string,
  endDate: string,
  limit = 500,
): Promise<JournalReportEntry[]> {
  const result = await db.execute(sql`
    SELECT e.id AS entry_id, e.entry_number, e.posting_date::text AS posting_date,
           e.source_type, e.source_id, e.memo AS entry_memo, e.reversal_of_entry_id,
           l.line_number, l.account_id, a.number AS account_number, a.name AS account_name,
           l.debit::text AS debit, l.credit::text AS credit, l.memo AS line_memo
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id = e.id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.organization_id = ${organizationId}
      AND e.posting_date BETWEEN ${startDate}::date AND ${endDate}::date
    ORDER BY e.posting_date, e.entry_number, l.line_number
    LIMIT ${limit * 10}
  `);
  const entries = new Map<string, JournalReportEntry>();
  for (const r of result.rows as Record<string, unknown>[]) {
    const id = r.entry_id as string;
    let entry = entries.get(id);
    if (!entry) {
      if (entries.size >= limit) break;
      entry = {
        entryId: id,
        entryNumber: Number(r.entry_number),
        postingDate: r.posting_date as string,
        sourceType: r.source_type as string,
        sourceId: r.source_id as string | null,
        memo: r.entry_memo as string | null,
        reversalOfEntryId: r.reversal_of_entry_id as string | null,
        lines: [],
      };
      entries.set(id, entry);
    }
    entry.lines.push({
      lineNumber: Number(r.line_number),
      accountId: r.account_id as string,
      accountNumber: r.account_number as string | null,
      accountName: r.account_name as string,
      debit: roundMoney(r.debit as string),
      credit: roundMoney(r.credit as string),
      memo: r.line_memo as string | null,
    });
  }
  return [...entries.values()];
}

export interface RegisterRow {
  entryId: string;
  entryNumber: number;
  postingDate: string;
  sourceType: string;
  sourceId: string | null;
  memo: string | null;
  debit: string;
  credit: string;
  cleared: boolean;
  reconciliationId: string | null;
  lineId: string;
  runningBalance: string;
}

/** Account register with running balance (oldest first). */
export async function accountRegister(
  db: DbOrTx,
  organizationId: string,
  accountId: string,
  options?: { startDate?: string; endDate?: string; limit?: number },
): Promise<{ rows: RegisterRow[]; endingBalance: string }> {
  const limit = Math.min(options?.limit ?? 500, 1000);
  const result = await db.execute(sql`
    SELECT e.id AS entry_id, e.entry_number, e.posting_date::text AS posting_date,
           e.source_type, e.source_id, COALESCE(l.memo, e.memo) AS memo,
           l.id AS line_id, l.debit::text AS debit, l.credit::text AS credit,
           l.cleared, l.reconciliation_id
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.organization_id = ${organizationId} AND l.account_id = ${accountId}
      ${options?.startDate ? sql`AND e.posting_date >= ${options.startDate}::date` : sql``}
      ${options?.endDate ? sql`AND e.posting_date <= ${options.endDate}::date` : sql``}
    ORDER BY e.posting_date, e.entry_number, l.line_number
    LIMIT ${limit}
  `);
  let running = '0';
  const rows = (result.rows as Record<string, unknown>[]).map((r) => {
    running = add(running, sub(r.debit as string, r.credit as string));
    return {
      entryId: r.entry_id as string,
      entryNumber: Number(r.entry_number),
      postingDate: r.posting_date as string,
      sourceType: r.source_type as string,
      sourceId: r.source_id as string | null,
      memo: r.memo as string | null,
      debit: roundMoney(r.debit as string),
      credit: roundMoney(r.credit as string),
      cleared: Boolean(r.cleared),
      reconciliationId: r.reconciliation_id as string | null,
      lineId: r.line_id as string,
      runningBalance: roundMoney(running),
    };
  });
  return { rows, endingBalance: roundMoney(running) };
}
