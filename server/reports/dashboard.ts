import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { roundMoney } from '@shared/money';

/**
 * Dashboard aggregates. Every number is computed in SQL from the same posted
 * journal/subledger data the reports use — never a cached or hand-maintained
 * total.
 */
export interface DashboardData {
  bankAccounts: { accountId: string; name: string; kind: string; balance: string }[];
  arOpenTotal: string;
  arOverdueTotal: string;
  apOpenTotal: string;
  apOverdueTotal: string;
  undepositedFunds: string;
  counts: {
    customers: number;
    vendors: number;
    accounts: number;
    invoicesOpen: number;
    billsOpen: number;
    bankItemsToReview: number;
  };
}

export async function getDashboardData(
  db: Db,
  organizationId: string,
  today: string,
): Promise<DashboardData> {
  const bankRows = await db.execute(sql`
    SELECT a.id AS account_id, a.name, fam.kind,
      COALESCE((
        SELECT CASE WHEN fam.kind = 'credit_card'
          THEN SUM(l.credit - l.debit) ELSE SUM(l.debit - l.credit) END
        FROM journal_lines l WHERE l.account_id = a.id
      ), 0)::text AS balance
    FROM accounts a
    JOIN financial_account_metadata fam ON fam.account_id = a.id
    WHERE a.organization_id = ${organizationId} AND a.active
    ORDER BY a.name
  `);

  const arRows = await db.execute(sql`
    WITH open_inv AS (
      SELECT i.id, i.due_date, i.total
        - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                    WHERE pa.invoice_id = i.id), 0)
        - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                    WHERE ca.invoice_id = i.id), 0)
        - COALESCE((SELECT SUM(w.amount) FROM invoice_write_offs w
                    WHERE w.invoice_id = i.id AND w.reversal_of_write_off_id IS NULL), 0)
        AS open_balance
      FROM invoices i
      WHERE i.organization_id = ${organizationId} AND i.posting_status = 'posted'
    )
    SELECT
      COALESCE(SUM(open_balance) FILTER (WHERE open_balance > 0), 0)::text AS open_total,
      COALESCE(SUM(open_balance) FILTER (WHERE open_balance > 0 AND due_date < ${today}::date), 0)::text AS overdue_total,
      COUNT(*) FILTER (WHERE open_balance > 0) AS open_count
    FROM open_inv
  `);

  const apRows = await db.execute(sql`
    WITH open_bills AS (
      SELECT b.id, b.due_date, b.total
        - COALESCE((SELECT SUM(pa.amount) FROM bill_payment_allocations pa
                    WHERE pa.bill_id = b.id), 0)
        - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                    WHERE va.bill_id = b.id), 0)
        AS open_balance
      FROM bills b
      WHERE b.organization_id = ${organizationId} AND b.posting_status = 'posted'
    )
    SELECT
      COALESCE(SUM(open_balance) FILTER (WHERE open_balance > 0), 0)::text AS open_total,
      COALESCE(SUM(open_balance) FILTER (WHERE open_balance > 0 AND due_date < ${today}::date), 0)::text AS overdue_total,
      COUNT(*) FILTER (WHERE open_balance > 0) AS open_count
    FROM open_bills
  `);

  const ufRows = await db.execute(sql`
    SELECT COALESCE((
      SELECT SUM(l.debit - l.credit) FROM journal_lines l
      WHERE l.account_id = s.undeposited_funds_account_id
    ), 0)::text AS balance
    FROM accounting_settings s
    WHERE s.organization_id = ${organizationId}
  `);

  const countRows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM customers c WHERE c.organization_id = ${organizationId} AND c.active) AS customers,
      (SELECT COUNT(*) FROM vendors v WHERE v.organization_id = ${organizationId} AND v.active) AS vendors,
      (SELECT COUNT(*) FROM accounts a WHERE a.organization_id = ${organizationId} AND a.active) AS accounts,
      (SELECT COUNT(*) FROM bank_feed_items f WHERE f.organization_id = ${organizationId}
        AND f.state IN ('new','suggested','possible_duplicate','needs_info')) AS bank_items
  `);

  const ar = arRows.rows[0] as { open_total: string; overdue_total: string; open_count: string };
  const ap = apRows.rows[0] as { open_total: string; overdue_total: string; open_count: string };
  const counts = countRows.rows[0] as {
    customers: string;
    vendors: string;
    accounts: string;
    bank_items: string;
  };

  return {
    bankAccounts: (
      bankRows.rows as { account_id: string; name: string; kind: string; balance: string }[]
    ).map((r) => ({
      accountId: r.account_id,
      name: r.name,
      kind: r.kind,
      balance: roundMoney(r.balance),
    })),
    arOpenTotal: roundMoney(ar.open_total),
    arOverdueTotal: roundMoney(ar.overdue_total),
    apOpenTotal: roundMoney(ap.open_total),
    apOverdueTotal: roundMoney(ap.overdue_total),
    undepositedFunds: roundMoney(
      (ufRows.rows[0] as { balance: string } | undefined)?.balance ?? '0',
    ),
    counts: {
      customers: Number(counts.customers),
      vendors: Number(counts.vendors),
      accounts: Number(counts.accounts),
      invoicesOpen: Number(ar.open_count),
      billsOpen: Number(ap.open_count),
      bankItemsToReview: Number(counts.bank_items),
    },
  };
}
