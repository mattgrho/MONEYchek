import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  accounts,
  creditAllocations,
  creditMemos,
  customerPaymentAllocations,
  customerPayments,
  customerRefunds,
  depositComponents,
  deposits,
  invoices,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry, reverseEntry } from '../accounting/posting';
import { getSystemAccountId } from '../accounting/accounts';
import { nextDocumentNumber } from '../accounting/sequences';
import { writeAuditEvent } from '../accounting/audit';
import { add, cmp, roundMoney, sub, sum } from '@shared/money';
import type { OrgContext } from './identity';
import { creditMemoUnapplied, invoiceOpenBalance } from './invoices';

/** Unapplied payment = amount - allocations - refunds (net of reversals). */
export async function paymentUnapplied(tx: Tx, paymentId: string, asOf?: string): Promise<string> {
  const result = await tx.execute(sql`
    SELECT p.amount
      - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                  WHERE pa.payment_id = p.id
                  ${asOf ? sql`AND pa.effective_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                  WHERE r.source_type = 'payment' AND r.source_id = p.id
                  ${asOf ? sql`AND r.refund_date <= ${asOf}::date` : sql``}), 0)
      AS unapplied
    FROM customer_payments p WHERE p.id = ${paymentId}
  `);
  const row = result.rows[0] as { unapplied: string } | undefined;
  if (!row) throw AppError.notFound('Payment not found');
  return roundMoney(row.unapplied);
}

/**
 * Validates and appends payment->invoice allocations. Locks the invoices to
 * prevent two concurrent applications from both consuming the same open
 * balance. History is append-only; unapply posts a reversing row.
 */
async function allocatePayment(
  tx: Tx,
  ctx: OrgContext,
  payment: typeof customerPayments.$inferSelect,
  allocations: { invoiceId: string; amount: string }[],
  effectiveDate: string,
): Promise<void> {
  if (allocations.length === 0) return;
  const requested = sum(allocations.map((a) => a.amount));
  const unapplied = await paymentUnapplied(tx, payment.id);
  if (cmp(requested, unapplied) > 0) {
    throw AppError.unprocessable(
      'OVER_APPLICATION',
      `Allocation (${roundMoney(requested)}) exceeds the payment's unapplied amount (${unapplied})`,
    );
  }
  for (const alloc of allocations) {
    if (cmp(alloc.amount, '0') <= 0) {
      throw AppError.unprocessable('INVALID_ALLOCATION', 'Allocations must be positive');
    }
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, alloc.invoiceId), eq(invoices.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!invoice || invoice.postingStatus !== 'posted') {
      throw AppError.unprocessable('INVALID_ALLOCATION', 'Allocations must target posted invoices');
    }
    if (invoice.customerId !== payment.customerId) {
      throw AppError.unprocessable(
        'INVALID_ALLOCATION',
        'Payments can only be applied to the same customer’s invoices',
      );
    }
    const open = await invoiceOpenBalance(tx, invoice.id);
    if (cmp(alloc.amount, open) > 0) {
      throw AppError.unprocessable(
        'OVER_APPLICATION',
        `Invoice ${invoice.number} has only ${open} open; cannot apply ${alloc.amount}`,
      );
    }
    await tx.insert(customerPaymentAllocations).values({
      organizationId: ctx.organizationId,
      paymentId: payment.id,
      invoiceId: invoice.id,
      amount: alloc.amount,
      effectiveDate,
      createdByUserId: ctx.userId,
    });
  }
}

/**
 * Records and posts a customer payment: Dr Bank/Undeposited Funds, Cr AR,
 * with optional immediate allocations (or oldest-due-first auto-apply).
 */
export async function receiveCustomerPayment(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId: string;
    paymentDate: string;
    amount: string;
    depositToAccountId: string;
    method?: string;
    reference?: string;
    memo?: string;
    allocations?: { invoiceId: string; amount: string }[];
    autoApply?: boolean;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string }> {
  if (cmp(input.amount, '0') <= 0) {
    throw AppError.validation('Payment amount must be positive');
  }
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'customer_payment.receive',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.depositToAccountId),
            eq(accounts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!account) throw AppError.validation('Unknown deposit-to account');
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'customer_payment');
      const [payment] = await tx
        .insert(customerPayments)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: input.customerId,
          paymentDate: input.paymentDate,
          method: input.method ?? null,
          reference: input.reference ?? null,
          amount: roundMoney(input.amount),
          depositToAccountId: input.depositToAccountId,
          memo: input.memo ?? null,
        })
        .returning();
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'customer_payment',
        sourceId: payment!.id,
        postingDate: input.paymentDate,
        memo: `Payment ${number}`,
        correlationId,
        auditAction: 'customer_payment.posted',
        auditPayload: { number, amount: roundMoney(input.amount) },
        lines: [
          { accountId: input.depositToAccountId, debit: input.amount, memo: `Payment ${number}` },
          {
            accountId: arId,
            credit: input.amount,
            partyType: 'customer',
            partyId: input.customerId,
            memo: `Payment ${number}`,
          },
        ],
      });
      await tx
        .update(customerPayments)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(customerPayments.id, payment!.id));

      const allocations = [...(input.allocations ?? [])];
      if (input.autoApply && allocations.length === 0) {
        // Oldest-due-first across the customer's open invoices.
        const open = await tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.organizationId, ctx.organizationId),
              eq(invoices.customerId, input.customerId),
              eq(invoices.postingStatus, 'posted'),
            ),
          )
          .orderBy(invoices.dueDate, invoices.invoiceDate)
          .for('update');
        let remaining = roundMoney(input.amount);
        for (const inv of open) {
          if (cmp(remaining, '0') <= 0) break;
          const openBalance = await invoiceOpenBalance(tx, inv.id);
          if (cmp(openBalance, '0') <= 0) continue;
          const apply = cmp(remaining, openBalance) <= 0 ? remaining : openBalance;
          allocations.push({ invoiceId: inv.id, amount: apply });
          remaining = sub(remaining, apply);
        }
      }
      await allocatePayment(
        tx,
        ctx,
        { ...payment!, postingStatus: 'posted' },
        allocations,
        input.paymentDate,
      );
      return { id: payment!.id, number, journalEntryId: entry.id };
    },
  );
  return result;
}

export async function applyPayment(
  db: Db,
  ctx: OrgContext,
  paymentId: string,
  input: {
    allocations: { invoiceId: string; amount: string }[];
    effectiveDate: string;
    idempotencyKey: string;
  },
  _correlationId: string,
): Promise<void> {
  await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'customer_payment.apply',
      payload: { paymentId, ...input },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [payment] = await tx
        .select()
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.id, paymentId),
            eq(customerPayments.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!payment || payment.postingStatus !== 'posted') {
        throw AppError.notFound('Posted payment not found');
      }
      await allocatePayment(tx, ctx, payment, input.allocations, input.effectiveDate);
      return {};
    },
  );
}

/** Unapply: append a reversing allocation, never edit or delete history. */
export async function unapplyPaymentAllocation(
  db: Db,
  ctx: OrgContext,
  allocationId: string,
  input: { effectiveDate: string; idempotencyKey: string },
  correlationId: string,
): Promise<void> {
  await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'customer_payment.unapply',
      payload: { allocationId, effectiveDate: input.effectiveDate },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [alloc] = await tx
        .select()
        .from(customerPaymentAllocations)
        .where(
          and(
            eq(customerPaymentAllocations.id, allocationId),
            eq(customerPaymentAllocations.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!alloc) throw AppError.notFound('Allocation not found');
      if (alloc.reversalOfAllocationId) {
        throw AppError.conflict('ALREADY_REVERSAL', 'This row is itself a reversal');
      }
      const [existing] = await tx
        .select({ id: customerPaymentAllocations.id })
        .from(customerPaymentAllocations)
        .where(eq(customerPaymentAllocations.reversalOfAllocationId, allocationId))
        .limit(1);
      if (existing) {
        throw AppError.conflict('ALREADY_UNAPPLIED', 'This allocation was already unapplied');
      }
      await tx.insert(customerPaymentAllocations).values({
        organizationId: ctx.organizationId,
        paymentId: alloc.paymentId,
        invoiceId: alloc.invoiceId,
        amount: `-${alloc.amount}`,
        effectiveDate: input.effectiveDate,
        reversalOfAllocationId: allocationId,
        createdByUserId: ctx.userId,
      });
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'customer_payment.unapplied',
        entityType: 'customer_payment_allocation',
        entityId: allocationId,
        correlationId,
      });
      return {};
    },
  );
}

/** Apply an open credit memo to invoices (non-posting subledger links). */
export async function applyCreditMemo(
  db: Db,
  ctx: OrgContext,
  creditMemoId: string,
  input: {
    allocations: { invoiceId: string; amount: string }[];
    effectiveDate: string;
    idempotencyKey: string;
  },
  _correlationId: string,
): Promise<void> {
  await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'credit_memo.apply',
      payload: { creditMemoId, ...input },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [credit] = await tx
        .select()
        .from(creditMemos)
        .where(
          and(eq(creditMemos.id, creditMemoId), eq(creditMemos.organizationId, ctx.organizationId)),
        )
        .for('update')
        .limit(1);
      if (!credit || credit.postingStatus !== 'posted') {
        throw AppError.notFound('Posted credit memo not found');
      }
      const requested = sum(input.allocations.map((a) => a.amount));
      const unapplied = await creditMemoUnapplied(tx, creditMemoId);
      if (cmp(requested, unapplied) > 0) {
        throw AppError.unprocessable(
          'OVER_APPLICATION',
          `Allocation exceeds the credit's unapplied amount (${unapplied})`,
        );
      }
      for (const alloc of input.allocations) {
        if (cmp(alloc.amount, '0') <= 0) {
          throw AppError.unprocessable('INVALID_ALLOCATION', 'Allocations must be positive');
        }
        const [invoice] = await tx
          .select()
          .from(invoices)
          .where(
            and(eq(invoices.id, alloc.invoiceId), eq(invoices.organizationId, ctx.organizationId)),
          )
          .for('update')
          .limit(1);
        if (!invoice || invoice.postingStatus !== 'posted') {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Allocations must target posted invoices',
          );
        }
        if (invoice.customerId !== credit.customerId) {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Credits apply only to the same customer’s invoices',
          );
        }
        const open = await invoiceOpenBalance(tx, invoice.id);
        if (cmp(alloc.amount, open) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Invoice ${invoice.number} has only ${open} open`,
          );
        }
        await tx.insert(creditAllocations).values({
          organizationId: ctx.organizationId,
          creditMemoId,
          invoiceId: invoice.id,
          amount: alloc.amount,
          effectiveDate: input.effectiveDate,
          createdByUserId: ctx.userId,
        });
      }
      return {};
    },
  );
}

/**
 * Refund of an unapplied customer credit (credit memo or payment balance):
 * Dr Accounts Receivable, Cr Bank. The original credit sits in AR as a
 * negative open item; the refund's AR debit extinguishes it, so AR nets to
 * zero and the subledger open item closes via the refund record.
 */
export async function refundCustomerCredit(
  db: Db,
  ctx: OrgContext,
  input: {
    sourceType: 'credit_memo' | 'payment';
    sourceId: string;
    amount: string;
    refundDate: string;
    bankAccountId: string;
    memo?: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'customer_refund.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (cmp(input.amount, '0') <= 0) {
        throw AppError.validation('Refund amount must be positive');
      }
      let customerId: string;
      if (input.sourceType === 'credit_memo') {
        const [credit] = await tx
          .select()
          .from(creditMemos)
          .where(
            and(
              eq(creditMemos.id, input.sourceId),
              eq(creditMemos.organizationId, ctx.organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!credit || credit.postingStatus !== 'posted') {
          throw AppError.notFound('Posted credit memo not found');
        }
        const unapplied = await creditMemoUnapplied(tx, credit.id);
        if (cmp(input.amount, unapplied) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Only ${unapplied} of this credit is unapplied`,
          );
        }
        customerId = credit.customerId;
      } else {
        const [payment] = await tx
          .select()
          .from(customerPayments)
          .where(
            and(
              eq(customerPayments.id, input.sourceId),
              eq(customerPayments.organizationId, ctx.organizationId),
            ),
          )
          .for('update')
          .limit(1);
        if (!payment || payment.postingStatus !== 'posted') {
          throw AppError.notFound('Posted payment not found');
        }
        const unapplied = await paymentUnapplied(tx, payment.id);
        if (cmp(input.amount, unapplied) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Only ${unapplied} of this payment is unapplied`,
          );
        }
        customerId = payment.customerId;
      }
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'customer_refund',
        sourceId: input.sourceId,
        postingDate: input.refundDate,
        memo: input.memo ?? 'Customer refund',
        correlationId,
        auditAction: 'customer_refund.posted',
        auditPayload: { sourceType: input.sourceType, amount: roundMoney(input.amount) },
        lines: [
          {
            accountId: arId,
            debit: input.amount,
            partyType: 'customer',
            partyId: customerId,
            memo: 'Refund of customer credit',
          },
          { accountId: input.bankAccountId, credit: input.amount, memo: 'Customer refund' },
        ],
      });
      await tx.insert(customerRefunds).values({
        organizationId: ctx.organizationId,
        customerId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        refundDate: input.refundDate,
        amount: roundMoney(input.amount),
        bankAccountId: input.bankAccountId,
        journalEntryId: entry.id,
        memo: input.memo ?? null,
      });
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/* --------------------------------- Deposits ------------------------------ */

export interface UndepositedReceipt {
  sourceType: 'customer_payment' | 'sales_receipt';
  sourceId: string;
  number: string;
  date: string;
  partyName: string | null;
  amount: string;
}

/** Receipts sitting in Undeposited Funds and not yet included in a deposit. */
export async function listUndepositedReceipts(
  db: Db,
  organizationId: string,
): Promise<UndepositedReceipt[]> {
  const result = await db.execute(sql`
    WITH uf AS (
      SELECT undeposited_funds_account_id AS id FROM accounting_settings
      WHERE organization_id = ${organizationId}
    )
    SELECT 'customer_payment' AS source_type, p.id AS source_id, p.number,
           p.payment_date::text AS date, c.display_name AS party_name, p.amount::text AS amount
    FROM customer_payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.organization_id = ${organizationId}
      AND p.posting_status = 'posted'
      AND p.deposit_to_account_id = (SELECT id FROM uf)
      AND NOT EXISTS (
        SELECT 1 FROM deposit_components dc
        JOIN deposits d ON d.id = dc.deposit_id AND d.posting_status = 'posted'
        WHERE dc.source_type = 'customer_payment' AND dc.source_id = p.id
      )
    UNION ALL
    SELECT 'sales_receipt', r.id, r.number, r.receipt_date::text,
           COALESCE(c.display_name, 'Walk-in'), r.total::text
    FROM sales_receipts r
    LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.organization_id = ${organizationId}
      AND r.posting_status = 'posted'
      AND r.deposit_to_account_id = (SELECT id FROM uf)
      AND NOT EXISTS (
        SELECT 1 FROM deposit_components dc
        JOIN deposits d ON d.id = dc.deposit_id AND d.posting_status = 'posted'
        WHERE dc.source_type = 'sales_receipt' AND dc.source_id = r.id
      )
    ORDER BY date
  `);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    sourceType: r.source_type as 'customer_payment' | 'sales_receipt',
    sourceId: r.source_id as string,
    number: r.number as string,
    date: r.date as string,
    partyName: r.party_name as string | null,
    amount: roundMoney(r.amount as string),
  }));
}

/**
 * Groups Undeposited Funds receipts (plus optional non-AR "other" lines such
 * as interest or owner contributions) into one bank deposit matching the real
 * statement total: Dr Bank, Cr Undeposited Funds / other credited accounts.
 */
export async function createDeposit(
  db: Db,
  ctx: OrgContext,
  input: {
    depositDate: string;
    bankAccountId: string;
    memo?: string;
    receipts: { sourceType: 'customer_payment' | 'sales_receipt'; sourceId: string }[];
    otherLines?: { accountId: string; amount: string; description?: string }[];
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string; total: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'deposit.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (input.receipts.length === 0 && (input.otherLines ?? []).length === 0) {
        throw AppError.validation('A deposit needs at least one line');
      }
      const ufId = await getSystemAccountId(tx, ctx.organizationId, 'undeposited_funds');
      const available = await listUndepositedReceiptsTx(tx, ctx.organizationId);
      const availableByKey = new Map(available.map((r) => [`${r.sourceType}:${r.sourceId}`, r]));
      let receiptsTotal = '0';
      const componentRows: {
        sourceType: 'customer_payment' | 'sales_receipt' | 'other';
        sourceId: string | null;
        accountId: string | null;
        description: string | null;
        amount: string;
      }[] = [];
      for (const pick of input.receipts) {
        const found = availableByKey.get(`${pick.sourceType}:${pick.sourceId}`);
        if (!found) {
          throw AppError.unprocessable(
            'RECEIPT_UNAVAILABLE',
            'A selected receipt is not in Undeposited Funds or was already deposited',
          );
        }
        receiptsTotal = add(receiptsTotal, found.amount);
        componentRows.push({
          sourceType: pick.sourceType,
          sourceId: pick.sourceId,
          accountId: null,
          description: `${found.number} — ${found.partyName ?? ''}`.trim(),
          amount: found.amount,
        });
      }
      let otherTotal = '0';
      for (const line of input.otherLines ?? []) {
        if (cmp(line.amount, '0') <= 0) {
          throw AppError.validation('Other deposit lines must be positive');
        }
        const [account] = await tx
          .select()
          .from(accounts)
          .where(
            and(eq(accounts.id, line.accountId), eq(accounts.organizationId, ctx.organizationId)),
          )
          .limit(1);
        if (!account) throw AppError.validation('Unknown account on a deposit line');
        if (account.systemKey === 'accounts_receivable') {
          throw AppError.unprocessable(
            'CONTROL_ACCOUNT_PROTECTED',
            'AR lines belong on customer payments, not directly on deposits',
          );
        }
        otherTotal = add(otherTotal, line.amount);
        componentRows.push({
          sourceType: 'other',
          sourceId: null,
          accountId: line.accountId,
          description: line.description ?? null,
          amount: roundMoney(line.amount),
        });
      }
      const total = roundMoney(add(receiptsTotal, otherTotal));
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'deposit');
      const [deposit] = await tx
        .insert(deposits)
        .values({
          organizationId: ctx.organizationId,
          number,
          depositDate: input.depositDate,
          bankAccountId: input.bankAccountId,
          memo: input.memo ?? null,
          total,
        })
        .returning();
      await tx.insert(depositComponents).values(
        componentRows.map((c, i) => ({
          organizationId: ctx.organizationId,
          depositId: deposit!.id,
          lineNumber: i + 1,
          sourceType: c.sourceType,
          sourceId: c.sourceId,
          accountId: c.accountId,
          description: c.description,
          amount: c.amount,
        })),
      );
      const lines = [
        { accountId: input.bankAccountId, debit: total, memo: `Deposit ${number}` },
        ...(cmp(receiptsTotal, '0') > 0
          ? [{ accountId: ufId, credit: roundMoney(receiptsTotal), memo: 'Undeposited receipts' }]
          : []),
        ...componentRows
          .filter((c) => c.sourceType === 'other')
          .map((c) => ({
            accountId: c.accountId!,
            credit: c.amount,
            memo: c.description ?? undefined,
          })),
      ];
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'deposit',
        sourceId: deposit!.id,
        postingDate: input.depositDate,
        memo: `Deposit ${number}`,
        correlationId,
        auditAction: 'deposit.posted',
        auditPayload: { number, total },
        lines,
      });
      await tx
        .update(deposits)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(deposits.id, deposit!.id));
      return { id: deposit!.id, number, journalEntryId: entry.id, total };
    },
  );
  return result;
}

async function listUndepositedReceiptsTx(tx: Tx, organizationId: string) {
  // Same query as listUndepositedReceipts but usable inside a transaction.
  const result = await tx.execute(sql`
    WITH uf AS (
      SELECT undeposited_funds_account_id AS id FROM accounting_settings
      WHERE organization_id = ${organizationId}
    )
    SELECT 'customer_payment' AS source_type, p.id AS source_id, p.number,
           p.payment_date::text AS date, c.display_name AS party_name, p.amount::text AS amount
    FROM customer_payments p
    JOIN customers c ON c.id = p.customer_id
    WHERE p.organization_id = ${organizationId}
      AND p.posting_status = 'posted'
      AND p.deposit_to_account_id = (SELECT id FROM uf)
      AND NOT EXISTS (
        SELECT 1 FROM deposit_components dc
        JOIN deposits d ON d.id = dc.deposit_id AND d.posting_status = 'posted'
        WHERE dc.source_type = 'customer_payment' AND dc.source_id = p.id
      )
    UNION ALL
    SELECT 'sales_receipt', r.id, r.number, r.receipt_date::text,
           COALESCE(c.display_name, 'Walk-in'), r.total::text
    FROM sales_receipts r
    LEFT JOIN customers c ON c.id = r.customer_id
    WHERE r.organization_id = ${organizationId}
      AND r.posting_status = 'posted'
      AND r.deposit_to_account_id = (SELECT id FROM uf)
      AND NOT EXISTS (
        SELECT 1 FROM deposit_components dc
        JOIN deposits d ON d.id = dc.deposit_id AND d.posting_status = 'posted'
        WHERE dc.source_type = 'sales_receipt' AND dc.source_id = r.id
      )
  `);
  return (result.rows as Record<string, unknown>[]).map((r) => ({
    sourceType: r.source_type as 'customer_payment' | 'sales_receipt',
    sourceId: r.source_id as string,
    number: r.number as string,
    date: r.date as string,
    partyName: r.party_name as string | null,
    amount: roundMoney(r.amount as string),
  }));
}

/** Void a payment: requires zero net applications; reverses the entry. */
export async function voidCustomerPayment(
  db: Db,
  ctx: OrgContext,
  paymentId: string,
  input: { reason: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'customer_payment.void',
      payload: { paymentId, reason: input.reason },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [payment] = await tx
        .select()
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.id, paymentId),
            eq(customerPayments.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!payment || payment.postingStatus !== 'posted' || !payment.journalEntryId) {
        throw AppError.notFound('Posted payment not found');
      }
      const unapplied = await paymentUnapplied(tx, paymentId);
      if (cmp(unapplied, payment.amount) !== 0) {
        throw AppError.unprocessable(
          'PAYMENT_HAS_APPLICATIONS',
          'Unapply this payment from its invoices before voiding it',
        );
      }
      const deposited = await tx.execute(sql`
        SELECT 1 FROM deposit_components dc
        JOIN deposits d ON d.id = dc.deposit_id AND d.posting_status = 'posted'
        WHERE dc.source_type = 'customer_payment' AND dc.source_id = ${paymentId}
        LIMIT 1
      `);
      if (deposited.rows.length > 0) {
        throw AppError.unprocessable(
          'PAYMENT_DEPOSITED',
          'This payment is part of a posted deposit; void the deposit first',
        );
      }
      const reconciled = await tx.execute(sql`
        SELECT 1 FROM journal_lines l
        JOIN reconciliation_items ri ON ri.journal_line_id = l.id
        JOIN reconciliations r ON r.id = ri.reconciliation_id AND r.status = 'completed'
        WHERE l.entry_id = ${payment.journalEntryId}
        LIMIT 1
      `);
      if (reconciled.rows.length > 0) {
        throw AppError.unprocessable(
          'LINE_RECONCILED',
          'This payment is part of a completed reconciliation; a correction must go through the reconciliation discrepancy workflow',
        );
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: payment.journalEntryId,
        postingDate: payment.paymentDate,
        reason: input.reason,
        correlationId,
        linkKind: 'void',
      });
      await tx
        .update(customerPayments)
        .set({
          postingStatus: 'voided',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: input.reason,
          updatedAt: new Date(),
          version: payment.version + 1,
        })
        .where(eq(customerPayments.id, paymentId));
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}
