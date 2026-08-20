import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { accounts, financialAccountMetadata, manualJournals } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry, reverseEntry } from '../accounting/posting';
import { accountHasActivity, getSystemAccountId, NORMAL_BALANCE } from '../accounting/accounts';
import { nextDocumentNumber } from '../accounting/sequences';
import { cmp, isDecimalString, neg, roundMoney, sub, sum } from '@shared/money';
import type { OrgContext } from './identity';
import type { AccountCategory } from '../db/schema/ledger';
import { writeAuditEvent } from '../accounting/audit';

/** Account creation/update. Bank & credit-card accounts get register metadata. */
export async function createAccount(
  db: Db,
  ctx: OrgContext,
  input: {
    name: string;
    number?: string | null;
    category: AccountCategory;
    detailType: string;
    description?: string | null;
    parentAccountId?: string | null;
    institutionName?: string | null;
    accountMask?: string | null;
  },
  correlationId: string,
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    if (input.parentAccountId) {
      const [parent] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.parentAccountId),
            eq(accounts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!parent) throw AppError.validation('Unknown parent account');
      if (parent.category !== input.category) {
        throw AppError.validation('Subaccounts must share their parent account type');
      }
    }
    const [row] = await tx
      .insert(accounts)
      .values({
        organizationId: ctx.organizationId,
        name: input.name.trim(),
        number: input.number?.trim() || null,
        category: input.category,
        detailType: input.detailType,
        normalBalance: NORMAL_BALANCE[input.category],
        description: input.description ?? null,
        parentAccountId: input.parentAccountId ?? null,
      })
      .returning({ id: accounts.id })
      .catch((err: { code?: string }) => {
        if (err.code === '23505') {
          throw AppError.conflict('DUPLICATE_ACCOUNT', 'An account with this name already exists');
        }
        throw err;
      });
    const isBankish = input.detailType === 'bank' || input.detailType === 'credit_card';
    if (isBankish) {
      await tx.insert(financialAccountMetadata).values({
        organizationId: ctx.organizationId,
        accountId: row!.id,
        kind: input.detailType === 'bank' ? 'bank' : 'credit_card',
        institutionName: input.institutionName ?? null,
        accountMask: input.accountMask ?? null,
      });
    }
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'account.created',
      entityType: 'account',
      entityId: row!.id,
      payload: { name: input.name, category: input.category, detailType: input.detailType },
      correlationId,
    });
    return { id: row!.id };
  });
}

export async function updateAccount(
  db: Db,
  ctx: OrgContext,
  accountId: string,
  input: {
    name?: string;
    number?: string | null;
    description?: string | null;
    active?: boolean;
    category?: AccountCategory;
    detailType?: string;
  },
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!account) throw AppError.notFound('Account not found');
    if (account.systemKey) {
      if (input.category || input.detailType || input.active === false) {
        throw AppError.unprocessable(
          'SYSTEM_ACCOUNT_PROTECTED',
          'Protected accounts cannot change type or be deactivated',
        );
      }
    }
    if (input.category && input.category !== account.category) {
      if (await accountHasActivity(tx, accountId)) {
        throw AppError.unprocessable(
          'ACCOUNT_HAS_ACTIVITY',
          'Account type changes are blocked once transactions exist; use an accountant-guided reclassification instead',
        );
      }
    }
    await tx
      .update(accounts)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.number !== undefined ? { number: input.number?.trim() || null } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.category !== undefined
          ? { category: input.category, normalBalance: NORMAL_BALANCE[input.category] }
          : {}),
        ...(input.detailType !== undefined ? { detailType: input.detailType } : {}),
        updatedAt: new Date(),
        version: account.version + 1,
      })
      .where(eq(accounts.id, accountId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'account.updated',
      entityType: 'account',
      entityId: accountId,
      payload: { changes: input as Record<string, unknown> },
      correlationId,
    });
  });
}

/** Delete only when unused and not protected; otherwise inactivate. */
export async function deleteAccount(
  db: Db,
  ctx: OrgContext,
  accountId: string,
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!account) throw AppError.notFound('Account not found');
    if (account.systemKey) {
      throw AppError.unprocessable(
        'SYSTEM_ACCOUNT_PROTECTED',
        'Protected accounts cannot be deleted',
      );
    }
    if (await accountHasActivity(tx, accountId)) {
      throw AppError.unprocessable(
        'ACCOUNT_HAS_ACTIVITY',
        'Accounts with transactions cannot be deleted; make the account inactive instead',
      );
    }
    await tx
      .delete(financialAccountMetadata)
      .where(eq(financialAccountMetadata.accountId, accountId));
    await tx.delete(accounts).where(eq(accounts.id, accountId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'account.deleted',
      entityType: 'account',
      entityId: accountId,
      payload: { name: account.name },
      correlationId,
    });
  });
}

const OPENING_BLOCKED_KEYS = new Set([
  'accounts_receivable',
  'accounts_payable',
  'inventory_asset',
  'undeposited_funds',
  'sales_tax_payable',
]);

/**
 * Opening balances: one explicit balanced journal entry against Opening
 * Balance Equity. Control-account openings (AR/AP/inventory/tax/UF) must go
 * through their subledger workflows, never through this plug.
 */
export async function postOpeningBalances(
  db: Db,
  ctx: OrgContext,
  input: {
    idempotencyKey: string;
    date: string;
    lines: { accountId: string; debit?: string; credit?: string }[];
  },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  if (input.lines.length === 0) throw AppError.validation('At least one line is required');
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'opening_balance',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      for (const line of input.lines) {
        const [account] = await tx
          .select({ systemKey: accounts.systemKey, name: accounts.name })
          .from(accounts)
          .where(
            and(eq(accounts.id, line.accountId), eq(accounts.organizationId, ctx.organizationId)),
          )
          .limit(1);
        if (!account) throw AppError.validation('Unknown account in opening balances');
        if (account.systemKey && OPENING_BLOCKED_KEYS.has(account.systemKey)) {
          throw AppError.unprocessable(
            'CONTROL_ACCOUNT_PROTECTED',
            `${account.name} openings must be established through their own workflows (open invoices/bills, inventory receipts), not an opening-balance plug`,
          );
        }
        const amount = line.debit ?? line.credit;
        if (!amount || !isDecimalString(amount) || cmp(amount, '0') <= 0) {
          throw AppError.validation('Opening balance amounts must be positive decimal strings');
        }
      }
      const totalDebits = sum(input.lines.map((l) => l.debit ?? '0'));
      const totalCredits = sum(input.lines.map((l) => l.credit ?? '0'));
      const diff = sub(totalDebits, totalCredits);
      const obeId = await getSystemAccountId(tx, ctx.organizationId, 'opening_balance_equity');
      const lines = input.lines.map((l) => ({
        accountId: l.accountId,
        ...(l.debit ? { debit: l.debit } : { credit: l.credit! }),
      }));
      if (cmp(diff, '0') > 0) {
        lines.push({ accountId: obeId, credit: roundMoney(diff) });
      } else if (cmp(diff, '0') < 0) {
        lines.push({ accountId: obeId, debit: roundMoney(neg(diff)) });
      } else {
        // Already balanced across entered accounts; still an OBE-style entry.
      }
      if (lines.length < 2) {
        throw AppError.validation('Opening balances need at least one non-zero line');
      }
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'opening_balance',
        postingDate: input.date,
        memo: 'Opening balances',
        correlationId,
        auditAction: 'opening_balance.posted',
        lines,
      });
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/** Manual journal drafts + posting (control accounts blocked by the engine). */
export async function createManualJournal(
  db: Db,
  ctx: OrgContext,
  input: {
    journalDate: string;
    memo?: string;
    lines: { accountId: string; debit?: string; credit?: string; memo?: string }[];
  },
): Promise<{ id: string }> {
  const normalized = normalizeManualLines(input.lines);
  const [row] = await db
    .insert(manualJournals)
    .values({
      organizationId: ctx.organizationId,
      journalDate: input.journalDate,
      memo: input.memo ?? null,
      lines: normalized,
      createdByUserId: ctx.userId,
    })
    .returning({ id: manualJournals.id });
  return { id: row!.id };
}

function normalizeManualLines(
  lines: { accountId: string; debit?: string; credit?: string; memo?: string }[],
): { accountId: string; debit: string; credit: string; memo?: string }[] {
  if (lines.length < 2) {
    throw AppError.validation('A journal entry needs at least two lines');
  }
  return lines.map((l, i) => {
    const hasDebit = Boolean(l.debit && cmp(l.debit, '0') !== 0);
    const hasCredit = Boolean(l.credit && cmp(l.credit, '0') !== 0);
    if (hasDebit === hasCredit) {
      throw AppError.validation(`Line ${i + 1} must have exactly one of debit or credit`);
    }
    const amount = hasDebit ? l.debit! : l.credit!;
    if (!isDecimalString(amount) || cmp(amount, '0') <= 0) {
      throw AppError.validation(`Line ${i + 1} amount must be a positive decimal`);
    }
    return {
      accountId: l.accountId,
      debit: hasDebit ? roundMoney(amount) : '0',
      credit: hasCredit ? roundMoney(amount) : '0',
      ...(l.memo ? { memo: l.memo } : {}),
    };
  });
}

export async function updateManualJournal(
  db: Db,
  ctx: OrgContext,
  id: string,
  input: {
    journalDate?: string;
    memo?: string | null;
    lines?: { accountId: string; debit?: string; credit?: string; memo?: string }[];
  },
): Promise<void> {
  const [row] = await db
    .select()
    .from(manualJournals)
    .where(and(eq(manualJournals.id, id), eq(manualJournals.organizationId, ctx.organizationId)))
    .limit(1);
  if (!row) throw AppError.notFound('Journal entry not found');
  if (row.postingStatus !== 'draft') {
    throw AppError.conflict('NOT_DRAFT', 'Posted journals are corrected by reversal, not editing');
  }
  await db
    .update(manualJournals)
    .set({
      ...(input.journalDate ? { journalDate: input.journalDate } : {}),
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      ...(input.lines ? { lines: normalizeManualLines(input.lines) } : {}),
      updatedAt: new Date(),
      version: row.version + 1,
    })
    .where(eq(manualJournals.id, id));
}

export async function postManualJournal(
  db: Db,
  ctx: OrgContext,
  id: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'manual_journal.post',
      payload: { id },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(manualJournals)
        .where(
          and(eq(manualJournals.id, id), eq(manualJournals.organizationId, ctx.organizationId)),
        )
        .for('update')
        .limit(1);
      if (!row) throw AppError.notFound('Journal entry not found');
      if (row.postingStatus !== 'draft') {
        throw AppError.conflict('NOT_DRAFT', 'This journal has already been posted');
      }
      const number =
        row.number ?? (await nextDocumentNumber(tx, ctx.organizationId, 'manual_journal'));
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'manual_journal',
        sourceId: row.id,
        postingDate: row.journalDate,
        memo: row.memo,
        correlationId,
        auditAction: 'manual_journal.posted',
        lines: row.lines.map((l) => ({
          accountId: l.accountId,
          ...(cmp(l.debit, '0') > 0 ? { debit: l.debit } : { credit: l.credit }),
          memo: l.memo,
        })),
      });
      await tx
        .update(manualJournals)
        .set({ postingStatus: 'posted', journalEntryId: entry.id, number, updatedAt: new Date() })
        .where(eq(manualJournals.id, row.id));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

export async function reverseManualJournal(
  db: Db,
  ctx: OrgContext,
  id: string,
  input: { reason: string; postingDate: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'manual_journal.reverse',
      payload: { id, reason: input.reason, postingDate: input.postingDate },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [row] = await tx
        .select()
        .from(manualJournals)
        .where(
          and(eq(manualJournals.id, id), eq(manualJournals.organizationId, ctx.organizationId)),
        )
        .for('update')
        .limit(1);
      if (!row) throw AppError.notFound('Journal entry not found');
      if (row.postingStatus !== 'posted' || !row.journalEntryId) {
        throw AppError.conflict('NOT_POSTED', 'Only posted journals can be reversed');
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: row.journalEntryId,
        postingDate: input.postingDate,
        reason: input.reason,
        correlationId,
      });
      await tx
        .update(manualJournals)
        .set({ postingStatus: 'reversed', updatedAt: new Date() })
        .where(eq(manualJournals.id, row.id));
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}

export async function listManualJournals(db: Db, ctx: OrgContext, limit = 200) {
  return db
    .select()
    .from(manualJournals)
    .where(eq(manualJournals.organizationId, ctx.organizationId))
    .orderBy(desc(manualJournals.journalDate), desc(manualJournals.createdAt))
    .limit(limit);
}
