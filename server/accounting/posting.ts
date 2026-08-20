import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { accounts, journalEntries, journalLines, journalLinks } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { isValidISODate } from '../lib/dates';
import { add, cmp, eq as moneyEq, isDecimalString, roundMoney, sum, toLedger } from '@shared/money';
import { acquireOrgLock, canonicalJson, writeAuditEvent } from './audit';
import { assertPostingAllowed, type PeriodOverride } from './periods';
import { nextJournalEntryNumber } from './sequences';

/**
 * THE posting engine. Every journal entry in the system is written here and
 * only here — no route, import, seed, or job writes journal rows directly.
 *
 * Guarantees on top of the database triggers:
 *  - >= 2 lines, debits == credits exactly, one positive side per line
 *  - active postable same-organization accounts only
 *  - protected control accounts accept only their allowed source types
 *  - posting date valid and inside an open (or overridden soft-closed) period
 *  - entry number assignment, canonical lines hash, audit event — atomically
 */

/** Which source types may touch each protected control account. */
const CONTROL_ACCOUNT_SOURCES: Record<string, readonly string[]> = {
  accounts_receivable: [
    'invoice',
    'customer_payment',
    'credit_memo',
    'sales_receipt',
    'write_off',
    'customer_refund',
    'deposit',
    'opening_migration',
  ],
  accounts_payable: ['bill', 'bill_payment', 'vendor_credit', 'vendor_refund', 'opening_migration'],
  undeposited_funds: ['customer_payment', 'sales_receipt', 'deposit', 'customer_refund'],
  inventory_asset: [
    'bill',
    'invoice',
    'credit_memo',
    'sales_receipt',
    'inventory_adjustment',
    'opening_migration',
  ],
  sales_tax_payable: [
    'invoice',
    'credit_memo',
    'sales_receipt',
    'tax_payment',
    'tax_adjustment',
    'write_off_tax_adjustment',
  ],
};

export interface PostLineInput {
  accountId: string;
  /** Exactly one of debit/credit must be a positive decimal string. */
  debit?: string;
  credit?: string;
  partyType?: 'customer' | 'vendor';
  partyId?: string;
  productId?: string;
  memo?: string;
}

export interface PostEntryInput {
  organizationId: string;
  actorUserId: string | null;
  actorRole?: string | null;
  sourceType: string;
  sourceId?: string | null;
  postingDate: string;
  memo?: string | null;
  lines: PostLineInput[];
  correlationId?: string | null;
  periodOverride?: PeriodOverride;
  /** Set internally when generating an exact reversal. */
  reversalOfEntryId?: string;
  auditAction?: string;
  auditPayload?: Record<string, unknown>;
}

export interface PostedEntry {
  id: string;
  entryNumber: number;
  postingDate: string;
  linesHash: string;
}

function computeLinesHash(lines: { accountId: string; debit: string; credit: string }[]): string {
  return createHash('sha256')
    .update(canonicalJson(lines.map((l) => ({ a: l.accountId, d: l.debit, c: l.credit }))))
    .digest('hex');
}

export async function postEntry(tx: Tx, input: PostEntryInput): Promise<PostedEntry> {
  if (!isValidISODate(input.postingDate)) {
    throw AppError.validation('Invalid posting date', { postingDate: ['Must be YYYY-MM-DD'] });
  }
  if (input.lines.length < 2) {
    throw AppError.unprocessable('UNBALANCED_ENTRY', 'A journal entry needs at least two lines');
  }

  // Normalize and validate line shape.
  const normalized = input.lines.map((line, i) => {
    const hasDebit = line.debit !== undefined && line.debit !== null && line.debit !== '';
    const hasCredit = line.credit !== undefined && line.credit !== null && line.credit !== '';
    if (hasDebit === hasCredit) {
      throw AppError.unprocessable(
        'INVALID_LINE',
        `Line ${i + 1} must have exactly one of debit or credit`,
      );
    }
    const raw = hasDebit ? line.debit! : line.credit!;
    if (!isDecimalString(raw)) {
      throw AppError.unprocessable('INVALID_LINE', `Line ${i + 1} amount must be a decimal string`);
    }
    if (cmp(raw, '0') <= 0) {
      throw AppError.unprocessable('INVALID_LINE', `Line ${i + 1} amount must be positive`);
    }
    const amount = toLedger(raw);
    return {
      accountId: line.accountId,
      debit: hasDebit ? amount : '0.0000',
      credit: hasCredit ? amount : '0.0000',
      partyType: line.partyType ?? null,
      partyId: line.partyId ?? null,
      productId: line.productId ?? null,
      memo: line.memo ?? null,
    };
  });

  const totalDebits = sum(normalized.map((l) => l.debit));
  const totalCredits = sum(normalized.map((l) => l.credit));
  if (!moneyEq(totalDebits, totalCredits)) {
    throw AppError.unprocessable(
      'UNBALANCED_ENTRY',
      `Debits (${roundMoney(totalDebits)}) must equal credits (${roundMoney(totalCredits)})`,
    );
  }

  // Serialize posting per organization (also serializes the audit chain).
  await acquireOrgLock(tx, input.organizationId);

  // Validate accounts: same org, active, postable; control-account protection.
  const accountIds = [...new Set(normalized.map((l) => l.accountId))];
  const accountRows = await tx
    .select({
      id: accounts.id,
      active: accounts.active,
      postable: accounts.postable,
      systemKey: accounts.systemKey,
      name: accounts.name,
    })
    .from(accounts)
    .where(
      and(eq(accounts.organizationId, input.organizationId), inArray(accounts.id, accountIds)),
    );
  const byId = new Map(accountRows.map((a) => [a.id, a]));
  const isReversal = Boolean(input.reversalOfEntryId);
  for (const line of normalized) {
    const account = byId.get(line.accountId);
    if (!account) {
      throw AppError.unprocessable('UNKNOWN_ACCOUNT', 'A line references an unknown account');
    }
    if (!account.active) {
      throw AppError.unprocessable('INACTIVE_ACCOUNT', `Account "${account.name}" is inactive`);
    }
    if (!account.postable) {
      throw AppError.unprocessable(
        'NON_POSTABLE_ACCOUNT',
        `Account "${account.name}" is a header account and cannot be posted to`,
      );
    }
    if (!isReversal && account.systemKey && CONTROL_ACCOUNT_SOURCES[account.systemKey]) {
      const allowed = CONTROL_ACCOUNT_SOURCES[account.systemKey]!;
      if (!allowed.includes(input.sourceType)) {
        throw AppError.unprocessable(
          'CONTROL_ACCOUNT_PROTECTED',
          `Account "${account.name}" is a controlled account; ${input.sourceType} entries may not post to it`,
        );
      }
    }
  }

  await assertPostingAllowed(tx, input.organizationId, input.postingDate, input.periodOverride);

  const entryNumber = await nextJournalEntryNumber(tx, input.organizationId);
  const linesHash = computeLinesHash(normalized);

  const [entry] = await tx
    .insert(journalEntries)
    .values({
      organizationId: input.organizationId,
      entryNumber,
      status: 'posted',
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      postingDate: input.postingDate,
      memo: input.memo ?? null,
      reversalOfEntryId: input.reversalOfEntryId ?? null,
      postedByUserId: input.actorUserId,
      correlationId: input.correlationId ?? null,
      linesHash,
    })
    .returning({
      id: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      postingDate: journalEntries.postingDate,
    });

  await tx.insert(journalLines).values(
    normalized.map((l, i) => ({
      organizationId: input.organizationId,
      entryId: entry!.id,
      lineNumber: i + 1,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      partyType: l.partyType,
      partyId: l.partyId,
      productId: l.productId,
      memo: l.memo,
    })),
  );

  await writeAuditEvent(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole ?? null,
    action: input.auditAction ?? 'journal.posted',
    entityType: 'journal_entry',
    entityId: entry!.id,
    payload: {
      entryNumber,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      postingDate: input.postingDate,
      totalDebits: roundMoney(totalDebits),
      linesHash,
      ...(input.auditPayload ?? {}),
    },
    correlationId: input.correlationId ?? null,
  });

  return { id: entry!.id, entryNumber, postingDate: entry!.postingDate, linesHash };
}

/**
 * Posts an exact linked reversal of an existing entry (debits and credits
 * swapped). The original gains reversed_by_entry_id (the single mutable
 * field the append-only trigger allows).
 */
export async function reverseEntry(
  tx: Tx,
  input: {
    organizationId: string;
    actorUserId: string | null;
    actorRole?: string | null;
    entryId: string;
    postingDate: string;
    reason: string;
    correlationId?: string | null;
    periodOverride?: PeriodOverride;
    sourceType?: string;
    sourceId?: string | null;
    linkKind?: 'reversal' | 'void' | 'correction' | 'nsf';
  },
): Promise<PostedEntry> {
  await acquireOrgLock(tx, input.organizationId);
  const [original] = await tx
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.id, input.entryId),
        eq(journalEntries.organizationId, input.organizationId),
      ),
    )
    .for('update')
    .limit(1);
  if (!original) throw AppError.notFound('Journal entry not found');
  if (original.reversedByEntryId) {
    throw AppError.conflict('ALREADY_REVERSED', 'This entry has already been reversed');
  }

  const lines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, original.id))
    .orderBy(journalLines.lineNumber);

  const reversal = await postEntry(tx, {
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole ?? null,
    sourceType: input.sourceType ?? 'reversal',
    sourceId: input.sourceId ?? original.sourceId,
    postingDate: input.postingDate,
    memo: `Reversal of #${original.entryNumber}: ${input.reason}`,
    correlationId: input.correlationId ?? null,
    periodOverride: input.periodOverride,
    reversalOfEntryId: original.id,
    auditAction: 'journal.reversed',
    auditPayload: { reversedEntryId: original.id, reason: input.reason },
    lines: lines.map((l) => ({
      accountId: l.accountId,
      // Swap sides. Ledger amounts are stored as exact 4-dp strings.
      ...(cmp(l.debit, '0') > 0 ? { credit: l.debit } : { debit: l.credit }),
      partyType: l.partyType ?? undefined,
      partyId: l.partyId ?? undefined,
      productId: l.productId ?? undefined,
      memo: l.memo ?? undefined,
    })),
  });

  await tx
    .update(journalEntries)
    .set({ reversedByEntryId: reversal.id })
    .where(eq(journalEntries.id, original.id));

  await tx.insert(journalLinks).values({
    organizationId: input.organizationId,
    fromEntryId: original.id,
    toEntryId: reversal.id,
    kind: input.linkKind ?? 'reversal',
  });

  return reversal;
}

/** Convenience for tests/reports: signed balance of an account as of a date. */
export function signedBalanceExpression(): string {
  return 'SUM(debit - credit)';
}

export { sum as sumMoney, add as addMoney };
