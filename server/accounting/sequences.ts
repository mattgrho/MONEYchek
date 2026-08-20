import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { numberSequences } from '../db/schema/index';

/**
 * Concurrency-safe, organization- and document-type-scoped numbering.
 * Rows are locked FOR UPDATE for the increment, so two simultaneous posts can
 * never receive the same number. Assigned numbers are never recycled.
 */

export const DOCUMENT_TYPES = [
  'journal_entry',
  'estimate',
  'invoice',
  'customer_payment',
  'credit_memo',
  'sales_receipt',
  'deposit',
  'bill',
  'bill_payment',
  'vendor_credit',
  'expense',
  'manual_journal',
  'purchase_order',
  'retainer',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

const DEFAULT_PREFIXES: Record<DocumentType, string> = {
  journal_entry: '',
  estimate: 'EST-',
  invoice: 'INV-',
  customer_payment: 'PMT-',
  credit_memo: 'CM-',
  sales_receipt: 'SR-',
  deposit: 'DEP-',
  bill: 'BILL-',
  bill_payment: 'BP-',
  vendor_credit: 'VC-',
  expense: 'EXP-',
  manual_journal: 'JE-',
  purchase_order: 'PO-',
  retainer: 'RET-',
};

async function nextValue(
  tx: Tx,
  organizationId: string,
  documentType: DocumentType,
): Promise<{ value: number; prefix: string; padding: number }> {
  await tx
    .insert(numberSequences)
    .values({
      organizationId,
      documentType,
      prefix: DEFAULT_PREFIXES[documentType],
      nextValue: 1,
      padding: documentType === 'journal_entry' ? 0 : 4,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(numberSequences)
    .where(
      and(
        eq(numberSequences.organizationId, organizationId),
        eq(numberSequences.documentType, documentType),
      ),
    )
    .for('update')
    .limit(1);
  if (!row) throw new Error('sequence row missing after upsert');
  await tx
    .update(numberSequences)
    .set({ nextValue: row.nextValue + 1, updatedAt: sql`now()` })
    .where(eq(numberSequences.id, row.id));
  return { value: row.nextValue, prefix: row.prefix, padding: row.padding };
}

/** Formatted human-readable document number, e.g. INV-0042. */
export async function nextDocumentNumber(
  tx: Tx,
  organizationId: string,
  documentType: DocumentType,
): Promise<string> {
  const { value, prefix, padding } = await nextValue(tx, organizationId, documentType);
  const digits = padding > 0 ? String(value).padStart(padding, '0') : String(value);
  return `${prefix}${digits}`;
}

/** Bare monotonic journal-entry number. */
export async function nextJournalEntryNumber(tx: Tx, organizationId: string): Promise<number> {
  const { value } = await nextValue(tx, organizationId, 'journal_entry');
  return value;
}
