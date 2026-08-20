import type { DbOrTx } from '../db/client';
import { accountRegister, type RegisterRow } from './financial';
import { sql } from 'drizzle-orm';

export * from './financial';
export * from './dashboard';

export interface GeneralLedgerAccountBlock {
  accountId: string;
  number: string | null;
  name: string;
  category: string;
  openingBalance: string;
  rows: RegisterRow[];
  endingBalance: string;
}

/**
 * General Ledger: per-account activity for a range with opening/closing
 * balances derived from the same journal lines as every other report.
 */
export async function generalLedgerAvailable(
  db: DbOrTx,
  organizationId: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<{ startDate: string; endDate: string; accounts: GeneralLedgerAccountBlock[] }> {
  const { add, roundMoney, sub } = await import('@shared/money');
  const accountsResult = await db.execute(sql`
    SELECT DISTINCT a.id, a.number, a.name, a.category
    FROM accounts a
    JOIN journal_lines l ON l.account_id = a.id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.organization_id = ${organizationId}
      AND e.posting_date <= ${endDate}::date
      ${accountId ? sql`AND a.id = ${accountId}` : sql``}
    ORDER BY a.number NULLS LAST, a.name
    LIMIT 200
  `);
  const blocks: GeneralLedgerAccountBlock[] = [];
  for (const row of accountsResult.rows as Record<string, unknown>[]) {
    const id = row.id as string;
    const openingResult = await db.execute(sql`
      SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS opening
      FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.account_id = ${id} AND e.posting_date < ${startDate}::date
    `);
    const opening = (openingResult.rows[0] as { opening: string }).opening;
    const register = await accountRegister(db, organizationId, id, { startDate, endDate });
    // Re-base running balances on the opening balance.
    let running = opening;
    const rows = register.rows.map((r) => {
      running = add(running, sub(r.debit, r.credit));
      return { ...r, runningBalance: roundMoney(running) };
    });
    blocks.push({
      accountId: id,
      number: row.number as string | null,
      name: row.name as string,
      category: row.category as string,
      openingBalance: roundMoney(opening),
      rows,
      endingBalance: roundMoney(running),
    });
  }
  return { startDate, endDate, accounts: blocks };
}
