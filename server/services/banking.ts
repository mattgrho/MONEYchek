import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  accounts,
  bankFeedItems,
  bankImportBatches,
  bankRuleApplications,
  bankRules,
  financialAccountMetadata,
  journalEntries,
  journalLines,
  reconciliationItems,
  reconciliations,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { normalizeAmount, normalizeDate, parseCsv } from '../lib/csv';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry } from '../accounting/posting';
import { writeAuditEvent } from '../accounting/audit';
import { abs, add, cmp, eq as moneyEq, neg, roundMoney, sub, sum } from '@shared/money';
import type { OrgContext } from './identity';

/* ------------------------------- CSV import ------------------------------- */

export interface CsvMapping {
  dateColumn: number;
  descriptionColumn: number;
  referenceColumn?: number | null;
  /** Either a single signed amount column, or separate debit/credit columns. */
  amountColumn?: number | null;
  debitColumn?: number | null; // money out
  creditColumn?: number | null; // money in
  dateFormat: 'MDY' | 'DMY' | 'YMD';
  hasHeader: boolean;
  /** For single-amount files: positive values mean money in (default) or out. */
  positiveIsMoneyIn?: boolean;
}

interface ParsedRow {
  rowNumber: number;
  date: string;
  description: string;
  reference: string | null;
  amount: string; // signed: positive = money in
}

function fingerprint(
  accountId: string,
  row: { date: string; description: string; amount: string },
): string {
  const normalized = row.description.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update(`${accountId}|${row.date}|${normalized}|${roundMoney(row.amount)}`)
    .digest('hex');
}

export function parseStatementCsv(
  content: string,
  mapping: CsvMapping,
): { rows: ParsedRow[]; errors: { row: number; message: string }[] } {
  const raw = parseCsv(content);
  const rows: ParsedRow[] = [];
  const errors: { row: number; message: string }[] = [];
  const start = mapping.hasHeader ? 1 : 0;
  for (let i = start; i < raw.length; i++) {
    const cells = raw[i]!;
    const rowNumber = i + 1;
    if (cells.every((c) => c.trim() === '')) continue;
    const dateRaw = cells[mapping.dateColumn] ?? '';
    const date = normalizeDate(dateRaw, mapping.dateFormat);
    if (!date) {
      errors.push({ row: rowNumber, message: `Unreadable date "${dateRaw}"` });
      continue;
    }
    const description = (cells[mapping.descriptionColumn] ?? '').trim();
    const reference =
      mapping.referenceColumn != null
        ? (cells[mapping.referenceColumn] ?? '').trim() || null
        : null;
    let amount: string | null = null;
    if (mapping.amountColumn != null) {
      amount = normalizeAmount(cells[mapping.amountColumn] ?? '');
      if (amount && mapping.positiveIsMoneyIn === false) amount = neg(amount);
    } else if (mapping.debitColumn != null || mapping.creditColumn != null) {
      const debit =
        mapping.debitColumn != null ? normalizeAmount(cells[mapping.debitColumn] ?? '') : null;
      const credit =
        mapping.creditColumn != null ? normalizeAmount(cells[mapping.creditColumn] ?? '') : null;
      if (debit && cmp(debit, '0') !== 0) amount = neg(abs(debit));
      else if (credit && cmp(credit, '0') !== 0) amount = abs(credit);
    }
    if (!amount || cmp(amount, '0') === 0) {
      errors.push({ row: rowNumber, message: 'Missing or zero amount' });
      continue;
    }
    rows.push({ rowNumber, date, description, reference, amount: roundMoney(amount) });
  }
  return { rows, errors };
}

/** Dry-run + import. Dry run never writes feed items. */
export async function importBankCsv(
  db: Db,
  ctx: OrgContext,
  input: {
    accountId: string;
    filename: string;
    content: string;
    mapping: CsvMapping;
    dryRun: boolean;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{
  batchId: string | null;
  rowCount: number;
  importedCount: number;
  duplicateCount: number;
  errorCount: number;
  errors: { row: number; message: string }[];
  preview: ParsedRow[];
}> {
  const [account] = await db
    .select()
    .from(financialAccountMetadata)
    .where(
      and(
        eq(financialAccountMetadata.accountId, input.accountId),
        eq(financialAccountMetadata.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  if (!account) {
    throw AppError.validation('Statement imports need a bank or credit-card account');
  }
  const { rows, errors } = parseStatementCsv(input.content, input.mapping);

  // Heuristic duplicates: same fingerprint already staged/added.
  const fingerprints = rows.map((r) => fingerprint(input.accountId, r));
  const existing = fingerprints.length
    ? await db
        .select({ fingerprint: bankFeedItems.fingerprint })
        .from(bankFeedItems)
        .where(
          and(
            eq(bankFeedItems.organizationId, ctx.organizationId),
            eq(bankFeedItems.accountId, input.accountId),
            inArray(bankFeedItems.fingerprint, fingerprints),
          ),
        )
    : [];
  const existingSet = new Set(existing.map((e) => e.fingerprint));
  const duplicateCount = fingerprints.filter((f) => existingSet.has(f)).length;

  if (input.dryRun) {
    return {
      batchId: null,
      rowCount: rows.length + errors.length,
      importedCount: rows.length,
      duplicateCount,
      errorCount: errors.length,
      errors,
      preview: rows.slice(0, 25),
    };
  }

  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'bank_import.execute',
      payload: {
        accountId: input.accountId,
        filename: input.filename,
        contentHash: createHash('sha256').update(input.content).digest('hex'),
        mapping: input.mapping,
      },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [batch] = await tx
        .insert(bankImportBatches)
        .values({
          organizationId: ctx.organizationId,
          accountId: input.accountId,
          filename: input.filename,
          mapping: input.mapping as unknown as Record<string, string>,
          rowCount: rows.length + errors.length,
          importedCount: rows.length,
          duplicateCount,
          errorCount: errors.length,
          errors,
          status: 'completed',
          idempotencyKey: input.idempotencyKey,
          createdByUserId: ctx.userId,
        })
        .returning({ id: bankImportBatches.id });
      const activeRules = await tx
        .select()
        .from(bankRules)
        .where(and(eq(bankRules.organizationId, ctx.organizationId), eq(bankRules.active, true)))
        .orderBy(asc(bankRules.priority));
      for (const [i, row] of rows.entries()) {
        const fp = fingerprints[rows.indexOf(row)] ?? fingerprint(input.accountId, row);
        void i;
        const isDuplicate = existingSet.has(fp);
        const [item] = await tx
          .insert(bankFeedItems)
          .values({
            organizationId: ctx.organizationId,
            accountId: input.accountId,
            batchId: batch!.id,
            txnDate: row.date,
            description: row.description,
            reference: row.reference,
            amount: row.amount,
            fingerprint: fp,
            state: isDuplicate ? 'possible_duplicate' : 'new',
          })
          .returning({ id: bankFeedItems.id, state: bankFeedItems.state });
        if (!isDuplicate) {
          const rule = matchRule(activeRules, row);
          if (rule) {
            await tx
              .update(bankFeedItems)
              .set({ state: 'suggested', appliedRuleId: rule.id })
              .where(eq(bankFeedItems.id, item!.id));
            await tx.insert(bankRuleApplications).values({
              organizationId: ctx.organizationId,
              ruleId: rule.id,
              ruleVersion: rule.version,
              feedItemId: item!.id,
              mode: 'suggested',
            });
          }
        }
      }
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'bank_import.completed',
        entityType: 'bank_import_batch',
        entityId: batch!.id,
        payload: {
          filename: input.filename,
          imported: rows.length,
          duplicates: duplicateCount,
          errors: errors.length,
        },
        correlationId,
      });
      return { batchId: batch!.id };
    },
  );
  return {
    batchId: result.batchId,
    rowCount: rows.length + errors.length,
    importedCount: rows.length,
    duplicateCount,
    errorCount: errors.length,
    errors,
    preview: rows.slice(0, 25),
  };
}

function matchRule(
  rules: (typeof bankRules.$inferSelect)[],
  row: { description: string; reference: string | null; amount: string },
): typeof bankRules.$inferSelect | null {
  for (const rule of rules) {
    const c = rule.conditions;
    if (c.direction === 'in' && cmp(row.amount, '0') < 0) continue;
    if (c.direction === 'out' && cmp(row.amount, '0') > 0) continue;
    const results = c.tests.map((t) => {
      const target =
        t.field === 'description'
          ? row.description.toLowerCase()
          : t.field === 'reference'
            ? (row.reference ?? '').toLowerCase()
            : abs(row.amount);
      const value = t.value.toLowerCase();
      switch (t.op) {
        case 'contains':
          return target.includes(value);
        case 'equals':
          return t.field === 'amount' ? moneyEq(target, t.value) : target === value;
        case 'starts_with':
          return target.startsWith(value);
        default:
          return false;
      }
    });
    const pass = c.matchType === 'all' ? results.every(Boolean) : results.some(Boolean);
    if (pass && results.length > 0) return rule;
  }
  return null;
}

/* ------------------------- Review: match / add / exclude ------------------ */

/** Candidate book transactions for matching a feed item. */
export async function suggestMatches(
  db: Db,
  ctx: OrgContext,
  feedItemId: string,
): Promise<
  {
    journalEntryId: string;
    entryNumber: number;
    postingDate: string;
    sourceType: string;
    memo: string | null;
    amount: string;
    lineId: string;
  }[]
> {
  const [item] = await db
    .select()
    .from(bankFeedItems)
    .where(
      and(eq(bankFeedItems.id, feedItemId), eq(bankFeedItems.organizationId, ctx.organizationId)),
    )
    .limit(1);
  if (!item) throw AppError.notFound('Bank item not found');
  // Money in = bank debit line; money out = bank credit line.
  const wantDebit = cmp(item.amount, '0') > 0;
  const magnitude = abs(item.amount);
  const result = await db.execute(sql`
    SELECT l.id AS line_id, l.entry_id, e.entry_number, e.posting_date::text AS posting_date,
           e.source_type, e.memo, (l.debit - l.credit)::text AS signed
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.organization_id = ${ctx.organizationId}
      AND l.account_id = ${item.accountId}
      AND l.cleared = false
      AND l.reconciliation_id IS NULL
      AND ${wantDebit ? sql`l.debit` : sql`l.credit`} = ${magnitude}
      AND e.posting_date BETWEEN ${item.txnDate}::date - 14 AND ${item.txnDate}::date + 14
      AND NOT EXISTS (
        SELECT 1 FROM bank_feed_items f
        WHERE f.matched_journal_entry_id = e.id AND f.state = 'matched'
      )
    ORDER BY ABS(e.posting_date - ${item.txnDate}::date)
    LIMIT 10
  `);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    journalEntryId: r.entry_id as string,
    entryNumber: Number(r.entry_number),
    postingDate: r.posting_date as string,
    sourceType: r.source_type as string,
    memo: r.memo as string | null,
    amount: roundMoney(r.signed as string),
    lineId: r.line_id as string,
  }));
}

/** Confirms a match: never posts a duplicate; marks the bank line cleared. */
export async function matchFeedItem(
  db: Db,
  ctx: OrgContext,
  feedItemId: string,
  journalEntryId: string,
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(bankFeedItems)
      .where(
        and(eq(bankFeedItems.id, feedItemId), eq(bankFeedItems.organizationId, ctx.organizationId)),
      )
      .for('update')
      .limit(1);
    if (!item) throw AppError.notFound('Bank item not found');
    if (item.state === 'matched' || item.state === 'added') {
      throw AppError.conflict('ALREADY_RESOLVED', 'This bank item is already resolved');
    }
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.id, journalEntryId),
          eq(journalEntries.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!entry) throw AppError.notFound('Journal entry not found');
    const lines = await tx
      .select()
      .from(journalLines)
      .where(
        and(eq(journalLines.entryId, journalEntryId), eq(journalLines.accountId, item.accountId)),
      );
    const bankEffect = sum(lines.map((l) => sub(l.debit, l.credit)));
    if (!moneyEq(bankEffect, item.amount)) {
      throw AppError.unprocessable(
        'MATCH_AMOUNT_MISMATCH',
        `The book transaction affects the bank account by ${roundMoney(bankEffect)}, but the statement line is ${roundMoney(item.amount)}`,
      );
    }
    await tx
      .update(bankFeedItems)
      .set({ state: 'matched', matchedJournalEntryId: journalEntryId, updatedAt: new Date() })
      .where(eq(bankFeedItems.id, feedItemId));
    for (const line of lines) {
      await tx.update(journalLines).set({ cleared: true }).where(eq(journalLines.id, line.id));
    }
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'bank_item.matched',
      entityType: 'bank_feed_item',
      entityId: feedItemId,
      payload: { journalEntryId, amount: roundMoney(item.amount) },
      correlationId,
    });
  });
}

/**
 * Categorize ("add"): creates a REAL transaction through the posting engine.
 * Money out: Dr category splits, Cr bank. Money in: Dr bank, Cr categories.
 */
export async function addFromFeedItem(
  db: Db,
  ctx: OrgContext,
  feedItemId: string,
  input: {
    splits: { accountId: string; amount: string; memo?: string }[];
    payeeName?: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'bank_item.add',
      payload: { feedItemId, ...input },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [item] = await tx
        .select()
        .from(bankFeedItems)
        .where(
          and(
            eq(bankFeedItems.id, feedItemId),
            eq(bankFeedItems.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!item) throw AppError.notFound('Bank item not found');
      if (item.state === 'matched' || item.state === 'added' || item.state === 'excluded') {
        throw AppError.conflict('ALREADY_RESOLVED', 'This bank item is already resolved');
      }
      if (input.splits.length === 0) throw AppError.validation('At least one category is required');
      const splitTotal = sum(input.splits.map((s) => s.amount));
      if (!moneyEq(splitTotal, abs(item.amount))) {
        throw AppError.unprocessable(
          'SPLIT_MISMATCH',
          `Split total (${roundMoney(splitTotal)}) must equal the statement amount (${roundMoney(abs(item.amount))})`,
        );
      }
      for (const split of input.splits) {
        if (cmp(split.amount, '0') <= 0) {
          throw AppError.validation('Split amounts must be positive');
        }
        const [account] = await tx
          .select()
          .from(accounts)
          .where(
            and(eq(accounts.id, split.accountId), eq(accounts.organizationId, ctx.organizationId)),
          )
          .limit(1);
        if (!account) throw AppError.validation('Unknown category account');
      }
      const moneyIn = cmp(item.amount, '0') > 0;
      const description = input.payeeName
        ? `${input.payeeName} — ${item.description}`
        : item.description;
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'bank_feed',
        sourceId: item.id,
        postingDate: item.txnDate,
        memo: description,
        correlationId,
        auditAction: 'bank_item.added',
        auditPayload: { description, amount: roundMoney(item.amount) },
        lines: moneyIn
          ? [
              { accountId: item.accountId, debit: abs(item.amount), memo: description },
              ...input.splits.map((s) => ({
                accountId: s.accountId,
                credit: s.amount,
                memo: s.memo ?? description,
              })),
            ]
          : [
              ...input.splits.map((s) => ({
                accountId: s.accountId,
                debit: s.amount,
                memo: s.memo ?? description,
              })),
              { accountId: item.accountId, credit: abs(item.amount), memo: description },
            ],
      });
      // The new bank line is cleared by definition (it came from the bank).
      const newLines = await tx
        .select()
        .from(journalLines)
        .where(and(eq(journalLines.entryId, entry.id), eq(journalLines.accountId, item.accountId)));
      for (const line of newLines) {
        await tx.update(journalLines).set({ cleared: true }).where(eq(journalLines.id, line.id));
      }
      await tx
        .update(bankFeedItems)
        .set({
          state: 'added',
          matchedJournalEntryId: entry.id,
          createdSourceType: 'bank_feed',
          createdSourceId: entry.id,
          updatedAt: new Date(),
        })
        .where(eq(bankFeedItems.id, feedItemId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/** One linked, balanced transfer entry between two bank/card accounts. */
export async function recordTransfer(
  db: Db,
  ctx: OrgContext,
  feedItemId: string,
  input: { otherAccountId: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'bank_item.transfer',
      payload: { feedItemId, otherAccountId: input.otherAccountId },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [item] = await tx
        .select()
        .from(bankFeedItems)
        .where(
          and(
            eq(bankFeedItems.id, feedItemId),
            eq(bankFeedItems.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!item) throw AppError.notFound('Bank item not found');
      if (['matched', 'added', 'excluded'].includes(item.state)) {
        throw AppError.conflict('ALREADY_RESOLVED', 'This bank item is already resolved');
      }
      const moneyIn = cmp(item.amount, '0') > 0;
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'transfer',
        sourceId: item.id,
        postingDate: item.txnDate,
        memo: `Transfer: ${item.description}`,
        correlationId,
        auditAction: 'bank_item.transfer',
        auditPayload: { amount: roundMoney(item.amount) },
        lines: moneyIn
          ? [
              { accountId: item.accountId, debit: abs(item.amount) },
              { accountId: input.otherAccountId, credit: abs(item.amount) },
            ]
          : [
              { accountId: input.otherAccountId, debit: abs(item.amount) },
              { accountId: item.accountId, credit: abs(item.amount) },
            ],
      });
      const newLines = await tx
        .select()
        .from(journalLines)
        .where(and(eq(journalLines.entryId, entry.id), eq(journalLines.accountId, item.accountId)));
      for (const line of newLines) {
        await tx.update(journalLines).set({ cleared: true }).where(eq(journalLines.id, line.id));
      }
      await tx
        .update(bankFeedItems)
        .set({ state: 'added', matchedJournalEntryId: entry.id, updatedAt: new Date() })
        .where(eq(bankFeedItems.id, feedItemId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

export async function setFeedItemState(
  db: Db,
  ctx: OrgContext,
  feedItemId: string,
  state: 'excluded' | 'new' | 'needs_info',
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(bankFeedItems)
      .where(
        and(eq(bankFeedItems.id, feedItemId), eq(bankFeedItems.organizationId, ctx.organizationId)),
      )
      .for('update')
      .limit(1);
    if (!item) throw AppError.notFound('Bank item not found');
    if (item.state === 'matched' || item.state === 'added') {
      throw AppError.conflict('ALREADY_RESOLVED', 'Resolved items cannot change state');
    }
    await tx
      .update(bankFeedItems)
      .set({ state, updatedAt: new Date() })
      .where(eq(bankFeedItems.id, feedItemId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: `bank_item.${state}`,
      entityType: 'bank_feed_item',
      entityId: feedItemId,
      correlationId,
    });
  });
}

/* ------------------------------ Reconciliation ---------------------------- */

/**
 * Reconciliation math (asset accounts; card accounts display as amount owed):
 *   cleared ending = previous reconciled ending + selected debits - credits
 *   difference = statement ending - cleared ending  (must be exactly 0)
 */
export async function startReconciliation(
  db: Db,
  ctx: OrgContext,
  input: {
    accountId: string;
    statementStartDate: string;
    statementEndDate: string;
    beginningBalance: string;
    endingBalance: string;
  },
  correlationId: string,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    const [meta] = await tx
      .select()
      .from(financialAccountMetadata)
      .where(
        and(
          eq(financialAccountMetadata.accountId, input.accountId),
          eq(financialAccountMetadata.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!meta) throw AppError.validation('Only bank and credit-card accounts reconcile');
    const [previous] = await tx
      .select()
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.organizationId, ctx.organizationId),
          eq(reconciliations.accountId, input.accountId),
          eq(reconciliations.status, 'completed'),
        ),
      )
      .orderBy(desc(reconciliations.statementEndDate))
      .limit(1);
    const expectedBeginning = previous ? roundMoney(previous.endingBalance) : '0.00';
    if (!moneyEq(input.beginningBalance, expectedBeginning)) {
      throw AppError.unprocessable(
        'BEGINNING_MISMATCH',
        previous
          ? `The beginning balance must equal the prior reconciliation's ending balance (${expectedBeginning})`
          : 'The first reconciliation starts from 0.00; establish an earlier balance with an opening-balance entry, then reconcile it',
      );
    }
    const [row] = await tx
      .insert(reconciliations)
      .values({
        organizationId: ctx.organizationId,
        accountId: input.accountId,
        statementStartDate: input.statementStartDate,
        statementEndDate: input.statementEndDate,
        beginningBalance: roundMoney(input.beginningBalance),
        endingBalance: roundMoney(input.endingBalance),
        previousReconciliationId: previous?.id ?? null,
      })
      .returning({ id: reconciliations.id })
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict(
            'RECONCILIATION_IN_PROGRESS',
            'A reconciliation for this account is already in progress',
          );
        }
        throw err;
      });
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'reconciliation.started',
      entityType: 'reconciliation',
      entityId: row!.id,
      payload: {
        accountId: input.accountId,
        endingBalance: roundMoney(input.endingBalance),
      },
      correlationId,
    });
    return { id: row!.id };
  });
}

export async function toggleReconciliationItem(
  db: Db,
  ctx: OrgContext,
  reconciliationId: string,
  journalLineId: string,
  selected: boolean,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [recon] = await tx
      .select()
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.id, reconciliationId),
          eq(reconciliations.organizationId, ctx.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status !== 'in_progress') {
      throw AppError.conflict('RECONCILIATION_COMPLETED', 'This reconciliation is complete');
    }
    const [line] = await tx
      .select()
      .from(journalLines)
      .where(
        and(
          eq(journalLines.id, journalLineId),
          eq(journalLines.organizationId, ctx.organizationId),
        ),
      )
      .limit(1);
    if (!line || line.accountId !== recon.accountId) {
      throw AppError.validation('That transaction is not in this account');
    }
    if (selected) {
      await tx
        .insert(reconciliationItems)
        .values({
          organizationId: ctx.organizationId,
          reconciliationId,
          journalLineId,
        })
        .onConflictDoNothing()
        .returning({ id: reconciliationItems.id })
        .then((rows) => {
          if (rows.length === 0 && line.reconciliationId) {
            throw AppError.conflict(
              'LINE_ALREADY_RECONCILED',
              'This transaction belongs to another reconciliation',
            );
          }
        });
      // Guard: the unique index rejects lines claimed by other recons.
      const [item] = await tx
        .select()
        .from(reconciliationItems)
        .where(eq(reconciliationItems.journalLineId, journalLineId))
        .limit(1);
      if (item && item.reconciliationId !== reconciliationId) {
        throw AppError.conflict(
          'LINE_ALREADY_RECONCILED',
          'This transaction belongs to another reconciliation',
        );
      }
    } else {
      await tx
        .delete(reconciliationItems)
        .where(
          and(
            eq(reconciliationItems.reconciliationId, reconciliationId),
            eq(reconciliationItems.journalLineId, journalLineId),
          ),
        );
    }
  });
}

export interface ReconciliationStatus {
  reconciliation: typeof reconciliations.$inferSelect;
  clearedDebits: string;
  clearedCredits: string;
  clearedEnding: string;
  difference: string;
  selectedLineIds: string[];
}

export async function reconciliationStatus(
  db: Db,
  ctx: OrgContext,
  reconciliationId: string,
): Promise<ReconciliationStatus> {
  const [recon] = await db
    .select()
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.id, reconciliationId),
        eq(reconciliations.organizationId, ctx.organizationId),
      ),
    )
    .limit(1);
  if (!recon) throw AppError.notFound('Reconciliation not found');
  const items = await db
    .select({ lineId: reconciliationItems.journalLineId })
    .from(reconciliationItems)
    .where(eq(reconciliationItems.reconciliationId, reconciliationId));
  const lineIds = items.map((i) => i.lineId);
  let debits = '0';
  let credits = '0';
  if (lineIds.length > 0) {
    const lines = await db
      .select({ debit: journalLines.debit, credit: journalLines.credit })
      .from(journalLines)
      .where(inArray(journalLines.id, lineIds));
    debits = sum(lines.map((l) => l.debit));
    credits = sum(lines.map((l) => l.credit));
  }
  const clearedEnding = roundMoney(add(recon.beginningBalance, sub(debits, credits)));
  const difference = roundMoney(sub(recon.endingBalance, clearedEnding));
  return {
    reconciliation: recon,
    clearedDebits: roundMoney(debits),
    clearedCredits: roundMoney(credits),
    clearedEnding,
    difference,
    selectedLineIds: lineIds,
  };
}

/** Completion requires an exact zero difference; snapshot is immutable. */
export async function completeReconciliation(
  db: Db,
  ctx: OrgContext,
  reconciliationId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ ok: true }> {
  await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'reconciliation.complete',
      payload: { reconciliationId },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [recon] = await tx
        .select()
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, reconciliationId),
            eq(reconciliations.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!recon) throw AppError.notFound('Reconciliation not found');
      if (recon.status !== 'in_progress') {
        throw AppError.conflict('RECONCILIATION_COMPLETED', 'Already completed');
      }
      const items = await tx
        .select({ lineId: reconciliationItems.journalLineId })
        .from(reconciliationItems)
        .where(eq(reconciliationItems.reconciliationId, reconciliationId));
      const lineIds = items.map((i) => i.lineId);
      let debits = '0';
      let credits = '0';
      let lineDetails: { id: string; debit: string; credit: string }[] = [];
      if (lineIds.length > 0) {
        const lines = await tx
          .select({ id: journalLines.id, debit: journalLines.debit, credit: journalLines.credit })
          .from(journalLines)
          .where(inArray(journalLines.id, lineIds))
          .for('update');
        lineDetails = lines;
        debits = sum(lines.map((l) => l.debit));
        credits = sum(lines.map((l) => l.credit));
      }
      const clearedEnding = roundMoney(add(recon.beginningBalance, sub(debits, credits)));
      const difference = roundMoney(sub(recon.endingBalance, clearedEnding));
      if (!moneyEq(difference, '0')) {
        throw AppError.unprocessable(
          'NONZERO_DIFFERENCE',
          `The difference is ${difference}; a reconciliation completes only at exactly zero`,
        );
      }
      for (const line of lineDetails) {
        await tx
          .update(journalLines)
          .set({ cleared: true, reconciliationId })
          .where(eq(journalLines.id, line.id));
      }
      await tx
        .update(reconciliations)
        .set({
          status: 'completed',
          completedByUserId: ctx.userId,
          completedAt: new Date(),
          snapshot: {
            beginningBalance: roundMoney(recon.beginningBalance),
            endingBalance: roundMoney(recon.endingBalance),
            clearedDebits: roundMoney(debits),
            clearedCredits: roundMoney(credits),
            difference: '0.00',
            lines: lineDetails.map((l) => ({
              lineId: l.id,
              debit: roundMoney(l.debit),
              credit: roundMoney(l.credit),
            })),
          },
          updatedAt: new Date(),
          version: recon.version + 1,
        })
        .where(eq(reconciliations.id, reconciliationId));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'reconciliation.completed',
        entityType: 'reconciliation',
        entityId: reconciliationId,
        payload: {
          endingBalance: roundMoney(recon.endingBalance),
          clearedDebits: roundMoney(debits),
          clearedCredits: roundMoney(credits),
        },
        correlationId,
      });
      return {};
    },
  );
  return { ok: true };
}

export async function abandonReconciliation(
  db: Db,
  ctx: OrgContext,
  reconciliationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [recon] = await tx
      .select()
      .from(reconciliations)
      .where(
        and(
          eq(reconciliations.id, reconciliationId),
          eq(reconciliations.organizationId, ctx.organizationId),
        ),
      )
      .for('update')
      .limit(1);
    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status !== 'in_progress') {
      throw AppError.conflict(
        'RECONCILIATION_COMPLETED',
        'Completed reconciliations are permanent',
      );
    }
    await tx
      .delete(reconciliationItems)
      .where(eq(reconciliationItems.reconciliationId, reconciliationId));
    await tx.delete(reconciliations).where(eq(reconciliations.id, reconciliationId));
  });
}
