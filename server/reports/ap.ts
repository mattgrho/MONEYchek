import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { add, cmp, neg, roundMoney, sum } from '@shared/money';

/**
 * AP aging as of a date. Signed open items:
 *  + posted bill open balances (total - dated payment/credit allocations)
 *  - unapplied vendor credits
 * The signed grand total equals the AP control-account CREDIT balance at the
 * same as-of date.
 */

export interface ApAgingRow {
  vendorId: string;
  vendorName: string;
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  credits: string;
  total: string;
}

export async function apAging(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
): Promise<{ asOf: string; rows: ApAgingRow[]; total: string }> {
  const billRows = await db.execute(sql`
    SELECT b.id, b.number, b.due_date::text AS due_date, b.vendor_id,
           v.display_name AS vendor_name,
           (b.total
             - COALESCE((SELECT SUM(pa.amount) FROM bill_payment_allocations pa
                         WHERE pa.bill_id = b.id AND pa.effective_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                         WHERE va.bill_id = b.id AND va.effective_date <= ${asOf}::date), 0)
           )::text AS open_balance,
           (${asOf}::date - b.due_date) AS days_overdue
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    WHERE b.organization_id = ${organizationId}
      AND b.posting_status = 'posted'
      AND b.bill_date <= ${asOf}::date
  `);
  const creditRows = await db.execute(sql`
    SELECT c.id, c.number, c.vendor_id, v.display_name AS vendor_name,
           (c.total
             - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                         WHERE va.vendor_credit_id = c.id AND va.effective_date <= ${asOf}::date), 0)
           )::text AS unapplied
    FROM vendor_credits c
    JOIN vendors v ON v.id = c.vendor_id
    WHERE c.organization_id = ${organizationId}
      AND c.posting_status = 'posted'
      AND c.credit_date <= ${asOf}::date
  `);

  const perVendor = new Map<
    string,
    {
      name: string;
      buckets: Record<
        'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'credits' | 'total',
        string
      >;
    }
  >();
  const empty = () => ({
    current: '0.00',
    d1_30: '0.00',
    d31_60: '0.00',
    d61_90: '0.00',
    d90_plus: '0.00',
    credits: '0.00',
    total: '0.00',
  });
  function addTo(
    vendorId: string,
    name: string,
    bucket: 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'credits',
    amount: string,
  ) {
    let entry = perVendor.get(vendorId);
    if (!entry) {
      entry = { name, buckets: empty() };
      perVendor.set(vendorId, entry);
    }
    entry.buckets[bucket] = roundMoney(add(entry.buckets[bucket], amount));
    entry.buckets.total = roundMoney(add(entry.buckets.total, amount));
  }
  for (const r of billRows.rows as Record<string, unknown>[]) {
    const open = roundMoney(r.open_balance as string);
    if (cmp(open, '0') <= 0) continue;
    const days = Number(r.days_overdue);
    const bucket =
      days <= 0
        ? 'current'
        : days <= 30
          ? 'd1_30'
          : days <= 60
            ? 'd31_60'
            : days <= 90
              ? 'd61_90'
              : 'd90_plus';
    addTo(r.vendor_id as string, r.vendor_name as string, bucket, open);
  }
  for (const r of creditRows.rows as Record<string, unknown>[]) {
    const unapplied = roundMoney(r.unapplied as string);
    if (cmp(unapplied, '0') <= 0) continue;
    addTo(r.vendor_id as string, r.vendor_name as string, 'credits', neg(unapplied));
  }
  const rows: ApAgingRow[] = [...perVendor.entries()]
    .map(([vendorId, entry]) => ({ vendorId, vendorName: entry.name, ...entry.buckets }))
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  return { asOf, rows, total: roundMoney(sum(rows.map((r) => r.total))) };
}

/** AP control-account GL credit balance at the as-of date. */
export async function apControlBalance(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
): Promise<string> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(l.credit - l.debit), 0)::text AS balance
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE l.organization_id = ${organizationId}
      AND a.system_key = 'accounts_payable'
      AND e.posting_date <= ${asOf}::date
  `);
  return roundMoney((result.rows[0] as { balance: string }).balance);
}
