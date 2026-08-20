import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  accounts,
  billLines,
  billPaymentAllocations,
  billPayments,
  bills,
  expenseLines,
  expenses,
  inventoryLayers,
  inventoryConsumptions,
  productsServices,
  purchasingSettings,
  vendorCreditAllocations,
  vendorCreditLines,
  vendorCredits,
  vendors,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry, reverseEntry, type PostLineInput } from '../accounting/posting';
import { receiveInventory } from '../accounting/inventory';
import { getSystemAccountId } from '../accounting/accounts';
import { nextDocumentNumber } from '../accounting/sequences';
import { writeAuditEvent } from '../accounting/audit';
import { add, cmp, div, isDecimalString, mul, roundMoney, sum } from '@shared/money';
import { addDaysISO } from '../lib/dates';
import type { OrgContext } from './identity';

export interface BillLineInput {
  accountId?: string | null;
  productId?: string | null;
  description?: string;
  quantity?: string | null;
  unitCost?: string | null;
  amount?: string | null;
  billableCustomerId?: string | null;
}

interface ResolvedBillLine {
  accountId: string | null;
  productId: string | null;
  productType: 'service' | 'non_inventory' | 'inventory' | null;
  description: string;
  quantity: string | null;
  unitCost: string | null;
  amount: string;
  billableCustomerId: string | null;
}

async function assertVendor(tx: Tx, organizationId: string, vendorId: string) {
  const [vendor] = await tx
    .select()
    .from(vendors)
    .where(and(eq(vendors.id, vendorId), eq(vendors.organizationId, organizationId)))
    .limit(1);
  if (!vendor) throw AppError.validation('Unknown vendor');
  return vendor;
}

/** Resolves bill/expense lines: account or product, exact amounts. */
async function resolveBillLines(
  tx: Tx,
  organizationId: string,
  lines: BillLineInput[],
): Promise<{ resolved: ResolvedBillLine[]; total: string }> {
  if (lines.length === 0) throw AppError.validation('At least one line is required');
  const resolved: ResolvedBillLine[] = [];
  for (const line of lines) {
    let product: typeof productsServices.$inferSelect | undefined;
    if (line.productId) {
      const [p] = await tx
        .select()
        .from(productsServices)
        .where(
          and(
            eq(productsServices.id, line.productId),
            eq(productsServices.organizationId, organizationId),
          ),
        )
        .limit(1);
      if (!p) throw AppError.validation('Unknown product on a line');
      product = p;
    }
    let accountId = line.accountId ?? null;
    if (!accountId && product) accountId = product.expenseAccountId;
    if (!accountId && product?.type !== 'inventory') {
      throw AppError.validation(
        'Each line needs an account (or a product with an expense account)',
      );
    }
    if (accountId) {
      const [account] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.organizationId, organizationId)))
        .limit(1);
      if (!account) throw AppError.validation('Unknown account on a line');
      if (
        account.systemKey &&
        ['accounts_receivable', 'accounts_payable', 'undeposited_funds'].includes(account.systemKey)
      ) {
        throw AppError.unprocessable(
          'CONTROL_ACCOUNT_PROTECTED',
          `${account.name} cannot be used as a purchase line category`,
        );
      }
    }
    let amount: string;
    if (product?.type === 'inventory' || (line.quantity && line.unitCost)) {
      const quantity = line.quantity ?? '1';
      const unitCost = line.unitCost ?? product?.purchaseCost ?? null;
      if (!unitCost || !isDecimalString(quantity) || !isDecimalString(unitCost)) {
        throw AppError.validation('Inventory/quantity lines need quantity and unit cost');
      }
      if (cmp(quantity, '0') <= 0 || cmp(unitCost, '0') < 0) {
        throw AppError.validation('Quantities must be positive; costs cannot be negative');
      }
      amount = roundMoney(mul(quantity, unitCost));
      resolved.push({
        accountId,
        productId: product?.id ?? null,
        productType: product?.type ?? null,
        description: line.description ?? product?.purchaseDescription ?? product?.name ?? '',
        quantity,
        unitCost,
        amount,
        billableCustomerId: line.billableCustomerId ?? null,
      });
    } else {
      if (!line.amount || !isDecimalString(line.amount) || cmp(line.amount, '0') <= 0) {
        throw AppError.validation('Each line needs a positive amount');
      }
      amount = roundMoney(line.amount);
      resolved.push({
        accountId,
        productId: product?.id ?? null,
        productType: product?.type ?? null,
        description: line.description ?? product?.purchaseDescription ?? '',
        quantity: line.quantity ?? null,
        unitCost: line.unitCost ?? null,
        amount,
        billableCustomerId: line.billableCustomerId ?? null,
      });
    }
  }
  return { resolved, total: roundMoney(sum(resolved.map((l) => l.amount))) };
}

/* ---------------------------------- Bills -------------------------------- */

export async function createBillDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    vendorId: string;
    billDate: string;
    dueDate?: string;
    termsDays?: number;
    vendorReference?: string;
    memo?: string;
    lines: BillLineInput[];
  },
): Promise<{ id: string; number: string; approvalRequired: boolean }> {
  return db.transaction(async (tx) => {
    const vendor = await assertVendor(tx, ctx.organizationId, input.vendorId);
    const { resolved, total } = await resolveBillLines(tx, ctx.organizationId, input.lines);
    const [purchSettings] = await tx
      .select()
      .from(purchasingSettings)
      .where(eq(purchasingSettings.organizationId, ctx.organizationId))
      .limit(1);
    const threshold = purchSettings?.billApprovalThreshold ?? null;
    const approvalRequired = threshold !== null && cmp(total, threshold) >= 0;
    const termsDays = input.termsDays ?? vendor.termsDays ?? 30;
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'bill');
    const [bill] = await tx
      .insert(bills)
      .values({
        organizationId: ctx.organizationId,
        number,
        vendorId: input.vendorId,
        vendorReference: input.vendorReference ?? null,
        billDate: input.billDate,
        dueDate: input.dueDate ?? addDaysISO(input.billDate, termsDays),
        termsDays,
        memo: input.memo ?? null,
        total,
        approvalStatus: approvalRequired ? 'pending' : 'not_required',
        submittedByUserId: ctx.userId,
        submittedAt: new Date(),
        createdByUserId: ctx.userId,
      })
      .returning({ id: bills.id, number: bills.number });
    await tx.insert(billLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        billId: bill!.id,
        lineNumber: i + 1,
        accountId: l.accountId,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitCost: l.unitCost,
        amount: l.amount,
        billableCustomerId: l.billableCustomerId,
      })),
    );
    return { id: bill!.id, number: bill!.number, approvalRequired };
  });
}

/** One-step bill approval with separation of duties. */
export async function decideBillApproval(
  db: Db,
  ctx: OrgContext,
  billId: string,
  input: { decision: 'approved' | 'rejected'; reason?: string },
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [bill] = await tx
      .select()
      .from(bills)
      .where(and(eq(bills.id, billId), eq(bills.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!bill) throw AppError.notFound('Bill not found');
    if (bill.approvalStatus !== 'pending') {
      throw AppError.conflict('NOT_PENDING', 'This bill is not awaiting approval');
    }
    const [purchSettings] = await tx
      .select()
      .from(purchasingSettings)
      .where(eq(purchasingSettings.organizationId, ctx.organizationId))
      .limit(1);
    if (
      purchSettings?.separationOfDuties &&
      bill.createdByUserId &&
      bill.createdByUserId === ctx.userId
    ) {
      throw AppError.forbidden('Separation of duties: the creator of a bill cannot approve it');
    }
    if (input.decision === 'rejected' && !input.reason) {
      throw AppError.validation('Rejection requires a reason', { reason: ['Required'] });
    }
    await tx
      .update(bills)
      .set(
        input.decision === 'approved'
          ? { approvalStatus: 'approved', approvedByUserId: ctx.userId, approvedAt: new Date() }
          : {
              approvalStatus: 'rejected',
              rejectedByUserId: ctx.userId,
              rejectedAt: new Date(),
              rejectionReason: input.reason ?? null,
            },
      )
      .where(eq(bills.id, billId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: `bill.${input.decision}`,
      entityType: 'bill',
      entityId: billId,
      reason: input.reason ?? null,
      payload: { number: bill.number, total: roundMoney(bill.total) },
      correlationId,
    });
  });
}

export async function billOpenBalance(tx: Tx, billId: string, asOf?: string): Promise<string> {
  const result = await tx.execute(sql`
    SELECT b.total
      - COALESCE((SELECT SUM(pa.amount) FROM bill_payment_allocations pa
                  WHERE pa.bill_id = b.id
                  ${asOf ? sql`AND pa.effective_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                  WHERE va.bill_id = b.id
                  ${asOf ? sql`AND va.effective_date <= ${asOf}::date` : sql``}), 0)
      AS open_balance
    FROM bills b WHERE b.id = ${billId}
  `);
  const row = result.rows[0] as { open_balance: string } | undefined;
  if (!row) throw AppError.notFound('Bill not found');
  return roundMoney(row.open_balance);
}

/** Posting a bill: Dr expense/asset/Inventory lines, Cr Accounts Payable. */
export async function postBill(
  db: Db,
  ctx: OrgContext,
  billId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'bill.post',
      payload: { billId },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [bill] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!bill) throw AppError.notFound('Bill not found');
      if (bill.postingStatus !== 'draft') {
        throw AppError.conflict('NOT_DRAFT', 'This bill has already been posted');
      }
      if (bill.approvalStatus === 'pending' || bill.approvalStatus === 'rejected') {
        throw AppError.unprocessable(
          'APPROVAL_REQUIRED',
          bill.approvalStatus === 'pending'
            ? 'This bill is awaiting approval'
            : 'This bill was rejected; edit and resubmit it',
        );
      }
      const lines = await tx
        .select()
        .from(billLines)
        .where(eq(billLines.billId, billId))
        .orderBy(billLines.lineNumber);
      const apId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_payable');
      const entryLines: PostLineInput[] = [];
      let inventoryTotal = '0';
      const inventoryReceipts: { productId: string; quantity: string; unitCost: string }[] = [];
      for (const line of lines) {
        let isInventory = false;
        if (line.productId) {
          const [product] = await tx
            .select()
            .from(productsServices)
            .where(eq(productsServices.id, line.productId))
            .limit(1);
          isInventory = product?.type === 'inventory';
        }
        if (isInventory) {
          if (!line.quantity || !line.unitCost) {
            throw AppError.validation('Inventory lines need quantity and unit cost');
          }
          inventoryTotal = add(inventoryTotal, line.amount);
          inventoryReceipts.push({
            productId: line.productId!,
            quantity: line.quantity,
            unitCost: line.unitCost,
          });
        } else {
          entryLines.push({
            accountId: line.accountId!,
            debit: line.amount,
            partyType: 'vendor',
            partyId: bill.vendorId,
            productId: line.productId ?? undefined,
            memo: line.description || undefined,
          });
        }
      }
      if (cmp(inventoryTotal, '0') > 0) {
        const inventoryId = await getSystemAccountId(tx, ctx.organizationId, 'inventory_asset');
        entryLines.push({
          accountId: inventoryId,
          debit: roundMoney(inventoryTotal),
          memo: `Inventory received on ${bill.number}`,
        });
      }
      entryLines.push({
        accountId: apId,
        credit: bill.total,
        partyType: 'vendor',
        partyId: bill.vendorId,
        memo: `Bill ${bill.number}`,
      });
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'bill',
        sourceId: billId,
        postingDate: bill.billDate,
        memo: `Bill ${bill.number}`,
        correlationId,
        auditAction: 'bill.posted',
        auditPayload: { number: bill.number, total: roundMoney(bill.total) },
        lines: entryLines,
      });
      for (const receipt of inventoryReceipts) {
        await receiveInventory(tx, {
          organizationId: ctx.organizationId,
          productId: receipt.productId,
          receiptDate: bill.billDate,
          quantity: receipt.quantity,
          unitCost: receipt.unitCost,
          sourceType: 'bill',
          sourceId: billId,
          journalEntryId: entry.id,
        });
      }
      await tx
        .update(bills)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
          updatedAt: new Date(),
          version: bill.version + 1,
        })
        .where(eq(bills.id, billId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

export async function voidBill(
  db: Db,
  ctx: OrgContext,
  billId: string,
  input: { reason: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'bill.void',
      payload: { billId, reason: input.reason },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [bill] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.id, billId), eq(bills.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!bill || bill.postingStatus !== 'posted' || !bill.journalEntryId) {
        throw AppError.notFound('Posted bill not found');
      }
      const open = await billOpenBalance(tx, billId);
      if (cmp(open, bill.total) !== 0) {
        throw AppError.unprocessable(
          'BILL_HAS_APPLICATIONS',
          'Unapply payments and credits before voiding this bill',
        );
      }
      // Inventory layers from this bill must be fully unconsumed.
      const layers = await tx
        .select()
        .from(inventoryLayers)
        .where(
          and(
            eq(inventoryLayers.organizationId, ctx.organizationId),
            eq(inventoryLayers.sourceType, 'bill'),
            eq(inventoryLayers.sourceId, billId),
          ),
        )
        .for('update');
      for (const layer of layers) {
        if (cmp(layer.remainingQuantity, layer.originalQuantity) !== 0) {
          throw AppError.unprocessable(
            'LAYER_CONSUMED',
            'Stock from this bill has already been sold; use a vendor credit / correction workflow instead of voiding',
          );
        }
      }
      for (const layer of layers) {
        await tx
          .update(inventoryLayers)
          .set({ remainingQuantity: '0', remainingValue: '0' })
          .where(eq(inventoryLayers.id, layer.id));
        await tx.insert(inventoryConsumptions).values({
          organizationId: ctx.organizationId,
          layerId: layer.id,
          productId: layer.productId,
          quantity: layer.originalQuantity,
          cost: layer.originalValue,
          sourceType: 'bill_void',
          sourceId: billId,
        });
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: bill.journalEntryId,
        postingDate: bill.billDate,
        reason: input.reason,
        correlationId,
        linkKind: 'void',
      });
      await tx
        .update(bills)
        .set({
          postingStatus: 'voided',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: input.reason,
          updatedAt: new Date(),
          version: bill.version + 1,
        })
        .where(eq(bills.id, billId));
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}

/* ---------------------------- Expenses / checks --------------------------- */

export async function createAndPostExpense(
  db: Db,
  ctx: OrgContext,
  input: {
    vendorId?: string | null;
    payeeName?: string | null;
    expenseDate: string;
    paymentAccountId: string;
    method: 'check' | 'card' | 'cash' | 'ach' | 'other';
    reference?: string;
    memo?: string;
    lines: {
      accountId: string;
      description?: string;
      amount: string;
      billableCustomerId?: string | null;
    }[];
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'expense.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (input.vendorId) await assertVendor(tx, ctx.organizationId, input.vendorId);
      const [paymentAccount] = await tx
        .select()
        .from(accounts)
        .where(
          and(
            eq(accounts.id, input.paymentAccountId),
            eq(accounts.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!paymentAccount) throw AppError.validation('Unknown payment account');
      const { resolved, total } = await resolveBillLines(
        tx,
        ctx.organizationId,
        input.lines.map((l) => ({ ...l })),
      );
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'expense');
      const [expense] = await tx
        .insert(expenses)
        .values({
          organizationId: ctx.organizationId,
          number,
          vendorId: input.vendorId ?? null,
          payeeName: input.payeeName ?? null,
          expenseDate: input.expenseDate,
          paymentAccountId: input.paymentAccountId,
          method: input.method,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
          total,
          createdByUserId: ctx.userId,
        })
        .returning();
      await tx.insert(expenseLines).values(
        resolved.map((l, i) => ({
          organizationId: ctx.organizationId,
          expenseId: expense!.id,
          lineNumber: i + 1,
          accountId: l.accountId!,
          description: l.description,
          amount: l.amount,
          billableCustomerId: l.billableCustomerId,
        })),
      );
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'expense',
        sourceId: expense!.id,
        postingDate: input.expenseDate,
        memo: `Expense ${number}`,
        correlationId,
        auditAction: 'expense.posted',
        auditPayload: { number, total },
        lines: [
          ...resolved.map((l) => ({
            accountId: l.accountId!,
            debit: l.amount,
            ...(input.vendorId ? { partyType: 'vendor' as const, partyId: input.vendorId } : {}),
            memo: l.description || undefined,
          })),
          { accountId: input.paymentAccountId, credit: total, memo: `Expense ${number}` },
        ],
      });
      await tx
        .update(expenses)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(expenses.id, expense!.id));
      return { id: expense!.id, number, journalEntryId: entry.id };
    },
  );
  return result;
}

export async function voidExpense(
  db: Db,
  ctx: OrgContext,
  expenseId: string,
  input: { reason: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'expense.void',
      payload: { expenseId, reason: input.reason },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [expense] = await tx
        .select()
        .from(expenses)
        .where(and(eq(expenses.id, expenseId), eq(expenses.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!expense || expense.postingStatus !== 'posted' || !expense.journalEntryId) {
        throw AppError.notFound('Posted expense not found');
      }
      const reconciled = await tx.execute(sql`
        SELECT 1 FROM journal_lines l
        JOIN reconciliation_items ri ON ri.journal_line_id = l.id
        JOIN reconciliations r ON r.id = ri.reconciliation_id AND r.status = 'completed'
        WHERE l.entry_id = ${expense.journalEntryId} LIMIT 1
      `);
      if (reconciled.rows.length > 0) {
        throw AppError.unprocessable(
          'LINE_RECONCILED',
          'This expense is part of a completed reconciliation; use the discrepancy workflow',
        );
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: expense.journalEntryId,
        postingDate: expense.expenseDate,
        reason: input.reason,
        correlationId,
        linkKind: 'void',
      });
      await tx
        .update(expenses)
        .set({
          postingStatus: 'voided',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: input.reason,
          updatedAt: new Date(),
          version: expense.version + 1,
        })
        .where(eq(expenses.id, expenseId));
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}

/* ------------------------------ Vendor credits ---------------------------- */

export async function createVendorCreditDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    vendorId: string;
    creditDate: string;
    memo?: string;
    lines: { accountId: string; description?: string; amount: string }[];
  },
): Promise<{ id: string; number: string }> {
  return db.transaction(async (tx) => {
    await assertVendor(tx, ctx.organizationId, input.vendorId);
    const { resolved, total } = await resolveBillLines(
      tx,
      ctx.organizationId,
      input.lines.map((l) => ({ ...l })),
    );
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'vendor_credit');
    const [credit] = await tx
      .insert(vendorCredits)
      .values({
        organizationId: ctx.organizationId,
        number,
        vendorId: input.vendorId,
        creditDate: input.creditDate,
        memo: input.memo ?? null,
        total,
      })
      .returning({ id: vendorCredits.id, number: vendorCredits.number });
    await tx.insert(vendorCreditLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        vendorCreditId: credit!.id,
        lineNumber: i + 1,
        accountId: l.accountId!,
        description: l.description,
        amount: l.amount,
      })),
    );
    return { id: credit!.id, number: credit!.number };
  });
}

/** Vendor credit posting: Dr AP, Cr original expense/asset accounts. */
export async function postVendorCredit(
  db: Db,
  ctx: OrgContext,
  vendorCreditId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'vendor_credit.post',
      payload: { vendorCreditId },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [credit] = await tx
        .select()
        .from(vendorCredits)
        .where(
          and(
            eq(vendorCredits.id, vendorCreditId),
            eq(vendorCredits.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!credit) throw AppError.notFound('Vendor credit not found');
      if (credit.postingStatus !== 'draft') {
        throw AppError.conflict('NOT_DRAFT', 'This vendor credit has already been posted');
      }
      const lines = await tx
        .select()
        .from(vendorCreditLines)
        .where(eq(vendorCreditLines.vendorCreditId, vendorCreditId))
        .orderBy(vendorCreditLines.lineNumber);
      const apId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_payable');
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'vendor_credit',
        sourceId: vendorCreditId,
        postingDate: credit.creditDate,
        memo: `Vendor credit ${credit.number}`,
        correlationId,
        auditAction: 'vendor_credit.posted',
        auditPayload: { number: credit.number, total: roundMoney(credit.total) },
        lines: [
          {
            accountId: apId,
            debit: credit.total,
            partyType: 'vendor',
            partyId: credit.vendorId,
            memo: `Vendor credit ${credit.number}`,
          },
          ...lines.map((l) => ({
            accountId: l.accountId!,
            credit: l.amount,
            partyType: 'vendor' as const,
            partyId: credit.vendorId,
            memo: l.description || undefined,
          })),
        ],
      });
      await tx
        .update(vendorCredits)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
          updatedAt: new Date(),
          version: credit.version + 1,
        })
        .where(eq(vendorCredits.id, vendorCreditId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

export async function vendorCreditUnapplied(tx: Tx, vendorCreditId: string): Promise<string> {
  const result = await tx.execute(sql`
    SELECT c.total
      - COALESCE((SELECT SUM(va.amount) FROM vendor_credit_allocations va
                  WHERE va.vendor_credit_id = c.id), 0) AS unapplied
    FROM vendor_credits c WHERE c.id = ${vendorCreditId}
  `);
  const row = result.rows[0] as { unapplied: string } | undefined;
  if (!row) throw AppError.notFound('Vendor credit not found');
  return roundMoney(row.unapplied);
}

export async function applyVendorCredit(
  db: Db,
  ctx: OrgContext,
  vendorCreditId: string,
  input: {
    allocations: { billId: string; amount: string }[];
    effectiveDate: string;
    idempotencyKey: string;
  },
): Promise<void> {
  await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'vendor_credit.apply',
      payload: { vendorCreditId, ...input },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [credit] = await tx
        .select()
        .from(vendorCredits)
        .where(
          and(
            eq(vendorCredits.id, vendorCreditId),
            eq(vendorCredits.organizationId, ctx.organizationId),
          ),
        )
        .for('update')
        .limit(1);
      if (!credit || credit.postingStatus !== 'posted') {
        throw AppError.notFound('Posted vendor credit not found');
      }
      const requested = sum(input.allocations.map((a) => a.amount));
      const unapplied = await vendorCreditUnapplied(tx, vendorCreditId);
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
        const [bill] = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.id, alloc.billId), eq(bills.organizationId, ctx.organizationId)))
          .for('update')
          .limit(1);
        if (!bill || bill.postingStatus !== 'posted') {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Allocations must target posted bills',
          );
        }
        if (bill.vendorId !== credit.vendorId) {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'Credits apply only to the same vendor’s bills',
          );
        }
        const open = await billOpenBalance(tx, bill.id);
        if (cmp(alloc.amount, open) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Bill ${bill.number} has only ${open} open`,
          );
        }
        await tx.insert(vendorCreditAllocations).values({
          organizationId: ctx.organizationId,
          vendorCreditId,
          billId: bill.id,
          amount: alloc.amount,
          effectiveDate: input.effectiveDate,
          createdByUserId: ctx.userId,
        });
      }
      return {};
    },
  );
}

/* ------------------------------ Bill payments ----------------------------- */

export async function payBills(
  db: Db,
  ctx: OrgContext,
  input: {
    vendorId: string;
    paymentDate: string;
    bankAccountId: string;
    method?: string;
    reference?: string;
    memo?: string;
    allocations: { billId: string; amount: string }[];
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string; amount: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'bill_payment.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (input.allocations.length === 0) {
        throw AppError.validation('Select at least one bill to pay');
      }
      await assertVendor(tx, ctx.organizationId, input.vendorId);
      const apId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_payable');
      let amount = '0';
      for (const alloc of input.allocations) {
        if (cmp(alloc.amount, '0') <= 0) {
          throw AppError.unprocessable('INVALID_ALLOCATION', 'Payment lines must be positive');
        }
        const [bill] = await tx
          .select()
          .from(bills)
          .where(and(eq(bills.id, alloc.billId), eq(bills.organizationId, ctx.organizationId)))
          .for('update')
          .limit(1);
        if (!bill || bill.postingStatus !== 'posted') {
          throw AppError.unprocessable('INVALID_ALLOCATION', 'Payments must target posted bills');
        }
        if (bill.vendorId !== input.vendorId) {
          throw AppError.unprocessable(
            'INVALID_ALLOCATION',
            'One bill payment pays one vendor; split payments by vendor',
          );
        }
        const open = await billOpenBalance(tx, bill.id);
        if (cmp(alloc.amount, open) > 0) {
          throw AppError.unprocessable(
            'OVER_APPLICATION',
            `Bill ${bill.number} has only ${open} open; cannot pay ${alloc.amount}`,
          );
        }
        amount = add(amount, alloc.amount);
      }
      amount = roundMoney(amount);
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'bill_payment');
      const [payment] = await tx
        .insert(billPayments)
        .values({
          organizationId: ctx.organizationId,
          number,
          vendorId: input.vendorId,
          paymentDate: input.paymentDate,
          bankAccountId: input.bankAccountId,
          method: input.method ?? null,
          reference: input.reference ?? null,
          amount,
          memo: input.memo ?? null,
        })
        .returning();
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'bill_payment',
        sourceId: payment!.id,
        postingDate: input.paymentDate,
        memo: `Bill payment ${number}`,
        correlationId,
        auditAction: 'bill_payment.posted',
        auditPayload: { number, amount },
        lines: [
          {
            accountId: apId,
            debit: amount,
            partyType: 'vendor',
            partyId: input.vendorId,
            memo: `Bill payment ${number}`,
          },
          { accountId: input.bankAccountId, credit: amount, memo: `Bill payment ${number}` },
        ],
      });
      await tx
        .update(billPayments)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(billPayments.id, payment!.id));
      for (const alloc of input.allocations) {
        await tx.insert(billPaymentAllocations).values({
          organizationId: ctx.organizationId,
          billPaymentId: payment!.id,
          billId: alloc.billId,
          amount: alloc.amount,
          effectiveDate: input.paymentDate,
          createdByUserId: ctx.userId,
        });
      }
      return { id: payment!.id, number, journalEntryId: entry.id, amount };
    },
  );
  return result;
}

export { div as _divInternal };
