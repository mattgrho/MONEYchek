import { sql } from 'drizzle-orm';
import { add, cmp, neg, roundMoney } from '@shared/money';
import type { DbOrTx } from '../db/client';

/**
 * Manual sales-tax center reporting. Collections are derived from the posted
 * source documents (invoice / sales receipt tax totals, credit memos as
 * negatives) grouped by the tax rate's agency, so the report matches what
 * appeared on customer documents. Remittances are the journal entries with
 * sourceType 'tax_payment' (the only non-document writer the Sales Tax
 * Payable control account allows). The as-of ledger balance is reported
 * alongside so the tie is visible, not assumed.
 */

export interface AgencyTaxRow {
  agencyName: string;
  taxableSales: string;
  taxCollected: string;
}

export interface SalesTaxReport {
  startDate: string;
  endDate: string;
  agencies: AgencyTaxRow[];
  totalCollected: string;
  remittedInPeriod: string;
  ledgerBalanceAsOf: string;
}

export async function salesTaxLiability(
  db: DbOrTx,
  organizationId: string,
  startDate: string,
  endDate: string,
): Promise<SalesTaxReport> {
  // Tax collected per agency from posted documents in the window. Voided
  // documents are excluded (their ledger effect is reversed too).
  const collected = await db.execute(sql`
    SELECT agency, SUM(taxable)::text AS taxable, SUM(tax)::text AS tax FROM (
      SELECT COALESCE(NULLIF(tr.agency_name, ''), 'Unassigned') AS agency,
             (SELECT COALESCE(SUM(il.amount), 0) FROM invoice_lines il
              WHERE il.invoice_id = i.id AND il.taxable) AS taxable,
             i.tax_total AS tax
      FROM invoices i
      LEFT JOIN tax_rates tr ON tr.id = i.tax_rate_id
      WHERE i.organization_id = ${organizationId}
        AND i.posting_status = 'posted'
        AND i.invoice_date BETWEEN ${startDate}::date AND ${endDate}::date
        AND i.tax_total <> 0
      UNION ALL
      SELECT COALESCE(NULLIF(tr.agency_name, ''), 'Unassigned'),
             (SELECT COALESCE(SUM(rl.amount), 0) FROM sales_receipt_lines rl
              WHERE rl.sales_receipt_id = s.id AND rl.taxable),
             s.tax_total
      FROM sales_receipts s
      LEFT JOIN tax_rates tr ON tr.id = s.tax_rate_id
      WHERE s.organization_id = ${organizationId}
        AND s.posting_status = 'posted'
        AND s.receipt_date BETWEEN ${startDate}::date AND ${endDate}::date
        AND s.tax_total <> 0
      UNION ALL
      SELECT COALESCE(NULLIF(tr.agency_name, ''), 'Unassigned'),
             -(SELECT COALESCE(SUM(ml.amount), 0) FROM credit_memo_lines ml
               WHERE ml.credit_memo_id = m.id AND ml.taxable),
             -m.tax_total
      FROM credit_memos m
      LEFT JOIN tax_rates tr ON tr.id = m.tax_rate_id
      WHERE m.organization_id = ${organizationId}
        AND m.posting_status = 'posted'
        AND m.credit_date BETWEEN ${startDate}::date AND ${endDate}::date
        AND m.tax_total <> 0
    ) docs
    GROUP BY agency
    ORDER BY agency
  `);

  const remitted = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS amount
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.organization_id = ${organizationId}
      AND a.system_key = 'sales_tax_payable'
      AND je.source_type = 'tax_payment'
      AND je.posting_date BETWEEN ${startDate}::date AND ${endDate}::date
  `);

  const glBalance = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS balance
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.organization_id = ${organizationId}
      AND a.system_key = 'sales_tax_payable'
      AND je.posting_date <= ${endDate}::date
  `);

  interface CollectedRow {
    agency: string;
    taxable: string;
    tax: string;
  }
  let total = '0';
  const agencies = (collected.rows as unknown as CollectedRow[]).map((r) => {
    const tax = roundMoney(r.tax);
    total = add(total, tax);
    return {
      agencyName: r.agency,
      taxableSales: roundMoney(r.taxable),
      taxCollected: tax,
    };
  });
  const remittedAmount = roundMoney((remitted.rows[0] as { amount: string }).amount);
  return {
    startDate,
    endDate,
    agencies,
    totalCollected: roundMoney(total),
    remittedInPeriod:
      cmp(remittedAmount, '0') < 0 ? roundMoney(neg(remittedAmount)) : remittedAmount,
    ledgerBalanceAsOf: roundMoney((glBalance.rows[0] as { balance: string }).balance),
  };
}

export interface TaxPaymentRow {
  journalEntryId: string;
  entryNumber: string;
  paymentDate: string;
  amount: string;
  memo: string | null;
}

/** Recorded remittances (journal entries with sourceType 'tax_payment'). */
export async function listTaxPayments(
  db: DbOrTx,
  organizationId: string,
  limit = 100,
): Promise<TaxPaymentRow[]> {
  const result = await db.execute(sql`
    SELECT je.id AS journal_entry_id, je.entry_number, je.posting_date::text AS payment_date,
           je.memo,
           COALESCE(SUM(CASE WHEN a.system_key = 'sales_tax_payable' THEN jl.debit ELSE 0 END), 0)::text AS amount
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id
    JOIN accounts a ON a.id = jl.account_id
    WHERE je.organization_id = ${organizationId}
      AND je.source_type = 'tax_payment'
      AND je.reversal_of_entry_id IS NULL
    GROUP BY je.id
    ORDER BY je.posting_date DESC, je.entry_number DESC
    LIMIT ${limit}
  `);
  interface Row {
    journal_entry_id: string;
    entry_number: string;
    payment_date: string;
    memo: string | null;
    amount: string;
  }
  return (result.rows as unknown as Row[]).map((r) => ({
    journalEntryId: r.journal_entry_id,
    entryNumber: r.entry_number,
    paymentDate: r.payment_date,
    amount: roundMoney(r.amount),
    memo: r.memo,
  }));
}
