import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { add, cmp, neg, roundMoney, sum } from '@shared/money';

/**
 * AR aging as of a date. Signed open items:
 *  + posted invoice open balances (total - dated allocations - write-offs)
 *  - unapplied customer payments (amount - dated allocations - refunds)
 *  - unapplied credit memos (total - dated allocations - refunds)
 * The signed grand total equals the AR control-account balance at the same
 * as-of date (asserted in tests and the close checklist).
 */

export interface AgingBuckets {
  current: string;
  d1_30: string;
  d31_60: string;
  d61_90: string;
  d90_plus: string;
  credits: string;
  total: string;
}

export interface ArAgingRow extends AgingBuckets {
  customerId: string;
  customerName: string;
}

export interface ArAgingDetailRow {
  customerId: string;
  customerName: string;
  kind: 'invoice' | 'payment_credit' | 'credit_memo';
  documentId: string;
  number: string;
  date: string;
  dueDate: string | null;
  amount: string; // signed open amount as of the report date
  daysOverdue: number | null;
}

const EMPTY: AgingBuckets = {
  current: '0.00',
  d1_30: '0.00',
  d31_60: '0.00',
  d61_90: '0.00',
  d90_plus: '0.00',
  credits: '0.00',
  total: '0.00',
};

export async function arAging(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
): Promise<{ asOf: string; rows: ArAgingRow[]; detail: ArAgingDetailRow[]; total: string }> {
  const invoiceRows = await db.execute(sql`
    SELECT i.id, i.number, i.invoice_date::text AS date, i.due_date::text AS due_date,
           i.customer_id, c.display_name AS customer_name,
           (i.total
             - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                         WHERE pa.invoice_id = i.id AND pa.effective_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                         WHERE ca.invoice_id = i.id AND ca.effective_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(w.amount) FROM invoice_write_offs w
                         WHERE w.invoice_id = i.id AND w.reversal_of_write_off_id IS NULL
                           AND w.write_off_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(ra.amount) FROM retainer_applications ra
                         WHERE ra.invoice_id = i.id AND ra.effective_date <= ${asOf}::date), 0)
           )::text AS open_balance,
           (${asOf}::date - i.due_date) AS days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.organization_id = ${organizationId}
      AND i.posting_status = 'posted'
      AND i.invoice_date <= ${asOf}::date
  `);

  const paymentRows = await db.execute(sql`
    SELECT p.id, p.number, p.payment_date::text AS date, p.customer_id,
           c.display_name AS customer_name,
           (p.amount
             - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                         WHERE pa.payment_id = p.id AND pa.effective_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                         WHERE r.source_type = 'payment' AND r.source_id = p.id
                           AND r.refund_date <= ${asOf}::date), 0)
             - CASE WHEN p.returned_date IS NOT NULL AND p.returned_date <= ${asOf}::date
                    THEN p.amount ELSE 0 END
           )::text AS unapplied
    FROM customer_payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.organization_id = ${organizationId}
      AND p.posting_status = 'posted'
      AND p.payment_date <= ${asOf}::date
  `);

  const creditRows = await db.execute(sql`
    SELECT m.id, m.number, m.credit_date::text AS date, m.customer_id,
           c.display_name AS customer_name,
           (m.total
             - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                         WHERE ca.credit_memo_id = m.id AND ca.effective_date <= ${asOf}::date), 0)
             - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                         WHERE r.source_type = 'credit_memo' AND r.source_id = m.id
                           AND r.refund_date <= ${asOf}::date), 0)
           )::text AS unapplied
    FROM credit_memos m
    JOIN customers c ON c.id = m.customer_id
    WHERE m.organization_id = ${organizationId}
      AND m.posting_status = 'posted'
      AND m.credit_date <= ${asOf}::date
  `);

  const detail: ArAgingDetailRow[] = [];
  const perCustomer = new Map<
    string,
    { name: string; buckets: Record<keyof AgingBuckets, string> }
  >();

  function bucketOf(daysOverdue: number): keyof AgingBuckets {
    if (daysOverdue <= 0) return 'current';
    if (daysOverdue <= 30) return 'd1_30';
    if (daysOverdue <= 60) return 'd31_60';
    if (daysOverdue <= 90) return 'd61_90';
    return 'd90_plus';
  }

  function addTo(customerId: string, name: string, bucket: keyof AgingBuckets, amount: string) {
    let entry = perCustomer.get(customerId);
    if (!entry) {
      entry = { name, buckets: { ...EMPTY } };
      perCustomer.set(customerId, entry);
    }
    entry.buckets[bucket] = roundMoney(add(entry.buckets[bucket], amount));
    entry.buckets.total = roundMoney(add(entry.buckets.total, amount));
  }

  for (const r of invoiceRows.rows as Record<string, unknown>[]) {
    const open = roundMoney(r.open_balance as string);
    if (cmp(open, '0') <= 0) continue;
    const days = Number(r.days_overdue);
    detail.push({
      customerId: r.customer_id as string,
      customerName: r.customer_name as string,
      kind: 'invoice',
      documentId: r.id as string,
      number: r.number as string,
      date: r.date as string,
      dueDate: r.due_date as string,
      amount: open,
      daysOverdue: days,
    });
    addTo(r.customer_id as string, r.customer_name as string, bucketOf(days), open);
  }
  for (const r of paymentRows.rows as Record<string, unknown>[]) {
    const unapplied = roundMoney(r.unapplied as string);
    if (cmp(unapplied, '0') <= 0) continue;
    detail.push({
      customerId: r.customer_id as string,
      customerName: r.customer_name as string,
      kind: 'payment_credit',
      documentId: r.id as string,
      number: r.number as string,
      date: r.date as string,
      dueDate: null,
      amount: roundMoney(neg(unapplied)),
      daysOverdue: null,
    });
    addTo(r.customer_id as string, r.customer_name as string, 'credits', neg(unapplied));
  }
  for (const r of creditRows.rows as Record<string, unknown>[]) {
    const unapplied = roundMoney(r.unapplied as string);
    if (cmp(unapplied, '0') <= 0) continue;
    detail.push({
      customerId: r.customer_id as string,
      customerName: r.customer_name as string,
      kind: 'credit_memo',
      documentId: r.id as string,
      number: r.number as string,
      date: r.date as string,
      dueDate: null,
      amount: roundMoney(neg(unapplied)),
      daysOverdue: null,
    });
    addTo(r.customer_id as string, r.customer_name as string, 'credits', neg(unapplied));
  }

  const rows: ArAgingRow[] = [...perCustomer.entries()]
    .map(([customerId, entry]) => ({ customerId, customerName: entry.name, ...entry.buckets }))
    .sort((a, b) => a.customerName.localeCompare(b.customerName));
  const total = roundMoney(sum(rows.map((r) => r.total)));
  return { asOf, rows, detail, total };
}

/** AR control-account GL balance at the same as-of date (for tie-out). */
export async function arControlBalance(
  db: DbOrTx,
  organizationId: string,
  asOf: string,
): Promise<string> {
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(l.debit - l.credit), 0)::text AS balance
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE l.organization_id = ${organizationId}
      AND a.system_key = 'accounts_receivable'
      AND e.posting_date <= ${asOf}::date
  `);
  return roundMoney((result.rows[0] as { balance: string }).balance);
}
