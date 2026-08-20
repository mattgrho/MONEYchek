import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client';
import {
  accountingSettings,
  creditMemoLines,
  creditMemos,
  customers,
  estimateLines,
  estimates,
  invoiceLines,
  invoiceWriteOffs,
  invoices,
  productsServices,
  salesReceiptLines,
  salesReceipts,
  taxRates,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry, reverseEntry, type PostLineInput } from '../accounting/posting';
import { consumeFifo, restoreConsumptions } from '../accounting/inventory';
import { getSystemAccountId } from '../accounting/accounts';
import { nextDocumentNumber } from '../accounting/sequences';
import { writeAuditEvent } from '../accounting/audit';
import { computeDocumentTotals } from '@shared/accounting/document-math';
import { add, cmp, roundMoney, sub, sum } from '@shared/money';
import { addDaysISO } from '../lib/dates';
import type { OrgContext } from './identity';

export interface SalesLineInput {
  productId?: string | null;
  description?: string;
  quantity: string;
  unitPrice: string;
  taxable?: boolean;
  incomeAccountId?: string | null;
  estimateLineId?: string | null;
}

interface ResolvedLine {
  productId: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  incomeAccountId: string;
  amount: string;
  taxAmount: string;
  productType: 'service' | 'non_inventory' | 'inventory' | null;
  estimateLineId: string | null;
}

/** Resolves product defaults + income accounts and computes exact totals. */
async function resolveLines(
  tx: Tx,
  organizationId: string,
  lines: SalesLineInput[],
  taxRateId: string | null,
): Promise<{
  resolved: ResolvedLine[];
  subtotal: string;
  taxTotal: string;
  total: string;
  taxSnapshot: { rate: string; name: string } | null;
}> {
  if (lines.length === 0) throw AppError.validation('At least one line is required');
  let taxSnapshot: { rate: string; name: string } | null = null;
  let rateFraction: string | null = null;
  if (taxRateId) {
    const [rate] = await tx
      .select()
      .from(taxRates)
      .where(and(eq(taxRates.id, taxRateId), eq(taxRates.organizationId, organizationId)))
      .limit(1);
    if (!rate || !rate.active) throw AppError.validation('Unknown or inactive tax rate');
    rateFraction = rate.rate;
    taxSnapshot = { rate: rate.rate, name: rate.name };
  }

  const [settings] = await tx
    .select()
    .from(accountingSettings)
    .where(eq(accountingSettings.organizationId, organizationId))
    .limit(1);

  const resolvedInputs: Omit<ResolvedLine, 'amount' | 'taxAmount'>[] = [];
  for (const line of lines) {
    if (cmp(line.quantity, '0') <= 0) {
      throw AppError.validation('Line quantities must be positive');
    }
    if (cmp(line.unitPrice, '0') < 0) {
      throw AppError.validation('Line prices cannot be negative');
    }
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
      if (!p) throw AppError.validation('Unknown product/service on a line');
      product = p;
    }
    const incomeAccountId =
      line.incomeAccountId ?? product?.incomeAccountId ?? settings?.defaultIncomeAccountId;
    if (!incomeAccountId) {
      throw AppError.unprocessable(
        'NO_INCOME_ACCOUNT',
        'No income account is configured for this line (set one on the product or in accounting settings)',
      );
    }
    resolvedInputs.push({
      productId: product?.id ?? null,
      description: line.description ?? product?.salesDescription ?? product?.name ?? '',
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxable: line.taxable ?? product?.taxable ?? false,
      incomeAccountId,
      productType: product?.type ?? null,
      estimateLineId: line.estimateLineId ?? null,
    });
  }

  const totals = computeDocumentTotals(
    resolvedInputs.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxable: l.taxable,
    })),
    rateFraction,
  );
  const resolved = resolvedInputs.map((l, i) => ({
    ...l,
    amount: totals.lines[i]!.amount,
    taxAmount: totals.lines[i]!.taxAmount,
  }));
  return {
    resolved,
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    taxSnapshot,
  };
}

async function assertCustomer(tx: Tx, organizationId: string, customerId: string) {
  const [customer] = await tx
    .select()
    .from(customers)
    .where(and(eq(customers.id, customerId), eq(customers.organizationId, organizationId)))
    .limit(1);
  if (!customer) throw AppError.validation('Unknown customer');
  return customer;
}

/* --------------------------------- Invoices ------------------------------ */

export async function createInvoiceDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId: string;
    invoiceDate: string;
    dueDate?: string;
    termsDays?: number;
    memo?: string;
    customerMessage?: string;
    taxRateId?: string | null;
    estimateId?: string | null;
    lines: SalesLineInput[];
  },
): Promise<{ id: string; number: string }> {
  return db.transaction(async (tx) => {
    const customer = await assertCustomer(tx, ctx.organizationId, input.customerId);
    const { resolved, subtotal, taxTotal, total } = await resolveLines(
      tx,
      ctx.organizationId,
      input.lines,
      input.taxRateId ?? null,
    );
    const termsDays = input.termsDays ?? customer.termsDays ?? 30;
    const dueDate = input.dueDate ?? addDaysISO(input.invoiceDate, termsDays);
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'invoice');
    const [invoice] = await tx
      .insert(invoices)
      .values({
        organizationId: ctx.organizationId,
        number,
        customerId: input.customerId,
        estimateId: input.estimateId ?? null,
        invoiceDate: input.invoiceDate,
        dueDate,
        termsDays,
        memo: input.memo ?? null,
        customerMessage: input.customerMessage ?? null,
        subtotal,
        taxTotal,
        total,
        taxRateId: input.taxRateId ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: invoices.id, number: invoices.number });
    await tx.insert(invoiceLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        invoiceId: invoice!.id,
        lineNumber: i + 1,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        taxable: l.taxable,
        incomeAccountId: l.incomeAccountId,
        estimateLineId: l.estimateLineId,
      })),
    );
    return { id: invoice!.id, number: invoice!.number };
  });
}

export async function updateInvoiceDraft(
  db: Db,
  ctx: OrgContext,
  invoiceId: string,
  input: {
    customerId?: string;
    invoiceDate?: string;
    dueDate?: string;
    memo?: string | null;
    customerMessage?: string | null;
    taxRateId?: string | null;
    lines?: SalesLineInput[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!invoice) throw AppError.notFound('Invoice not found');
    if (invoice.postingStatus !== 'draft') {
      throw AppError.conflict(
        'NOT_DRAFT',
        'Posted invoices are corrected with reverse-and-replace, not editing',
      );
    }
    if (input.customerId) await assertCustomer(tx, ctx.organizationId, input.customerId);
    let totals: { subtotal: string; taxTotal: string; total: string } | null = null;
    if (input.lines) {
      const { resolved, subtotal, taxTotal, total } = await resolveLines(
        tx,
        ctx.organizationId,
        input.lines,
        input.taxRateId !== undefined ? input.taxRateId : invoice.taxRateId,
      );
      await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      await tx.insert(invoiceLines).values(
        resolved.map((l, i) => ({
          organizationId: ctx.organizationId,
          invoiceId,
          lineNumber: i + 1,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          taxable: l.taxable,
          incomeAccountId: l.incomeAccountId,
          estimateLineId: l.estimateLineId,
        })),
      );
      totals = { subtotal, taxTotal, total };
    }
    await tx
      .update(invoices)
      .set({
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.invoiceDate ? { invoiceDate: input.invoiceDate } : {}),
        ...(input.dueDate ? { dueDate: input.dueDate } : {}),
        ...(input.memo !== undefined ? { memo: input.memo } : {}),
        ...(input.customerMessage !== undefined ? { customerMessage: input.customerMessage } : {}),
        ...(input.taxRateId !== undefined ? { taxRateId: input.taxRateId } : {}),
        ...(totals ?? {}),
        updatedAt: new Date(),
        version: invoice.version + 1,
      })
      .where(eq(invoices.id, invoiceId));
  });
}

/** Open balance = posted total - dated allocations/write-offs (net of reversals). */
export async function invoiceOpenBalance(
  tx: Tx,
  invoiceId: string,
  asOf?: string,
): Promise<string> {
  const result = await tx.execute(sql`
    SELECT i.total
      - COALESCE((SELECT SUM(pa.amount) FROM customer_payment_allocations pa
                  WHERE pa.invoice_id = i.id
                  ${asOf ? sql`AND pa.effective_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                  WHERE ca.invoice_id = i.id
                  ${asOf ? sql`AND ca.effective_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(w.amount) FROM invoice_write_offs w
                  WHERE w.invoice_id = i.id AND w.reversal_of_write_off_id IS NULL
                  ${asOf ? sql`AND w.write_off_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(ra.amount) FROM retainer_applications ra
                  WHERE ra.invoice_id = i.id
                  ${asOf ? sql`AND ra.effective_date <= ${asOf}::date` : sql``}), 0)
      AS open_balance
    FROM invoices i WHERE i.id = ${invoiceId}
  `);
  const row = result.rows[0] as { open_balance: string } | undefined;
  if (!row) throw AppError.notFound('Invoice not found');
  return roundMoney(row.open_balance);
}

/**
 * THE transition that posts an invoice. Freezes quantities, prices, tax
 * snapshot, account mappings, and totals; consumes FIFO layers for inventory
 * lines (COGS = consumed layer cost) in the same transaction.
 */
export async function postInvoice(
  db: Db,
  ctx: OrgContext,
  invoiceId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'invoice.post',
      payload: { invoiceId },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (invoice.postingStatus !== 'draft') {
        throw AppError.conflict('NOT_DRAFT', 'This invoice has already been posted');
      }
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoiceId))
        .orderBy(invoiceLines.lineNumber);
      if (lines.length === 0) throw AppError.unprocessable('EMPTY_INVOICE', 'Invoice has no lines');

      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entryLines: PostLineInput[] = [
        {
          accountId: arId,
          debit: invoice.total,
          partyType: 'customer',
          partyId: invoice.customerId,
          memo: `Invoice ${invoice.number}`,
        },
      ];
      for (const line of lines) {
        entryLines.push({
          accountId: line.incomeAccountId!,
          credit: line.amount,
          partyType: 'customer',
          partyId: invoice.customerId,
          productId: line.productId ?? undefined,
          memo: line.description || undefined,
        });
      }
      if (cmp(invoice.taxTotal, '0') > 0) {
        const taxId = await getSystemAccountId(tx, ctx.organizationId, 'sales_tax_payable');
        entryLines.push({
          accountId: taxId,
          credit: invoice.taxTotal,
          memo: `Sales tax on ${invoice.number}`,
        });
      }

      // Inventory lines: consume FIFO layers, add COGS + inventory credit.
      let totalCogs = '0';
      for (const line of lines) {
        if (!line.productId) continue;
        const [product] = await tx
          .select()
          .from(productsServices)
          .where(eq(productsServices.id, line.productId))
          .limit(1);
        if (product?.type !== 'inventory') continue;
        const { totalCost } = await consumeFifo(tx, {
          organizationId: ctx.organizationId,
          productId: line.productId,
          quantity: line.quantity,
          sourceType: 'invoice',
          sourceId: invoiceId,
        });
        totalCogs = add(totalCogs, totalCost);
      }
      if (cmp(totalCogs, '0') > 0) {
        const cogsId = await getSystemAccountId(tx, ctx.organizationId, 'cogs');
        const inventoryId = await getSystemAccountId(tx, ctx.organizationId, 'inventory_asset');
        entryLines.push({ accountId: cogsId, debit: roundMoney(totalCogs) });
        entryLines.push({ accountId: inventoryId, credit: roundMoney(totalCogs) });
      }

      const [taxSnapshotRow] = invoice.taxRateId
        ? await tx.select().from(taxRates).where(eq(taxRates.id, invoice.taxRateId)).limit(1)
        : [undefined];

      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'invoice',
        sourceId: invoiceId,
        postingDate: invoice.invoiceDate,
        memo: `Invoice ${invoice.number}`,
        correlationId,
        auditAction: 'invoice.posted',
        auditPayload: { number: invoice.number, total: invoice.total },
        lines: entryLines,
      });

      await tx
        .update(invoices)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
          taxSnapshot: taxSnapshotRow
            ? { rate: taxSnapshotRow.rate, name: taxSnapshotRow.name }
            : null,
          frozenDocument: {
            templateVersion: 1,
            number: invoice.number,
            invoiceDate: invoice.invoiceDate,
            dueDate: invoice.dueDate,
            subtotal: invoice.subtotal,
            taxTotal: invoice.taxTotal,
            total: invoice.total,
            lines: lines.map((l) => ({
              description: l.description,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              amount: l.amount,
              taxable: l.taxable,
            })),
          },
          updatedAt: new Date(),
          version: invoice.version + 1,
        })
        .where(eq(invoices.id, invoiceId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/**
 * Void: reverses AR/revenue/tax/COGS/inventory. Blocked while any payment or
 * credit remains applied, and requires explicit confirmation that inventory
 * physically returned when FIFO layers were consumed.
 */
export async function voidInvoice(
  db: Db,
  ctx: OrgContext,
  invoiceId: string,
  input: { reason: string; idempotencyKey: string; confirmInventoryReturn?: boolean },
  correlationId: string,
): Promise<{ reversalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'invoice.void',
      payload: { invoiceId, reason: input.reason },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (invoice.postingStatus !== 'posted' || !invoice.journalEntryId) {
        throw AppError.conflict('NOT_POSTED', 'Only posted invoices can be voided');
      }
      const open = await invoiceOpenBalance(tx, invoiceId);
      if (cmp(open, invoice.total) !== 0) {
        throw AppError.unprocessable(
          'INVOICE_HAS_APPLICATIONS',
          'Unapply or refund all payments and credits before voiding this invoice',
        );
      }
      const consumption = await tx.execute(sql`
        SELECT COUNT(*)::int AS n FROM inventory_consumptions
        WHERE organization_id = ${ctx.organizationId}
          AND source_type = 'invoice' AND source_id = ${invoiceId}
          AND reversal_of_consumption_id IS NULL
      `);
      const hadInventory = Number((consumption.rows[0] as { n: number }).n) > 0;
      if (hadInventory && !input.confirmInventoryReturn) {
        throw AppError.unprocessable(
          'INVENTORY_RETURN_CONFIRMATION_REQUIRED',
          'This invoice consumed stock. Voiding restores it — confirm the goods physically returned to usable stock, or issue a price-only credit memo instead',
        );
      }
      if (hadInventory) {
        await restoreConsumptions(tx, ctx.organizationId, 'invoice', invoiceId);
      }
      const reversal = await reverseEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        entryId: invoice.journalEntryId,
        postingDate: invoice.invoiceDate,
        reason: input.reason,
        correlationId,
        linkKind: 'void',
      });
      await tx
        .update(invoices)
        .set({
          postingStatus: 'voided',
          voidedAt: new Date(),
          voidedByUserId: ctx.userId,
          voidReason: input.reason,
          updatedAt: new Date(),
          version: invoice.version + 1,
        })
        .where(eq(invoices.id, invoiceId));
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'invoice.voided',
        entityType: 'invoice',
        entityId: invoiceId,
        reason: input.reason,
        payload: { number: invoice.number, reversalEntryId: reversal.id },
        correlationId,
      });
      return { reversalEntryId: reversal.id };
    },
  );
  return result;
}

/** Deliberate bad-debt write-off: Dr Bad Debt Expense, Cr AR. */
export async function writeOffInvoice(
  db: Db,
  ctx: OrgContext,
  invoiceId: string,
  input: { amount: string; date: string; reason: string; idempotencyKey: string },
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'invoice.write_off',
      payload: { invoiceId, amount: input.amount, date: input.date },
      actorUserId: ctx.userId,
    },
    async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, invoiceId), eq(invoices.organizationId, ctx.organizationId)))
        .for('update')
        .limit(1);
      if (!invoice) throw AppError.notFound('Invoice not found');
      if (invoice.postingStatus !== 'posted') {
        throw AppError.conflict('NOT_POSTED', 'Only posted invoices can be written off');
      }
      const open = await invoiceOpenBalance(tx, invoiceId);
      if (cmp(input.amount, '0') <= 0 || cmp(input.amount, open) > 0) {
        throw AppError.unprocessable(
          'INVALID_WRITE_OFF',
          `Write-off must be positive and no more than the open balance (${open})`,
        );
      }
      const badDebtId = await getSystemAccountId(tx, ctx.organizationId, 'bad_debt');
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'write_off',
        sourceId: invoiceId,
        postingDate: input.date,
        memo: `Write-off of invoice ${invoice.number}: ${input.reason}`,
        correlationId,
        auditAction: 'invoice.written_off',
        auditPayload: { number: invoice.number, amount: input.amount },
        lines: [
          { accountId: badDebtId, debit: input.amount },
          {
            accountId: arId,
            credit: input.amount,
            partyType: 'customer',
            partyId: invoice.customerId,
          },
        ],
      });
      await tx.insert(invoiceWriteOffs).values({
        organizationId: ctx.organizationId,
        invoiceId,
        writeOffDate: input.date,
        amount: input.amount,
        expenseAccountId: badDebtId,
        reason: input.reason,
        journalEntryId: entry.id,
        createdByUserId: ctx.userId,
      });
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/* ------------------------------- Credit memos ---------------------------- */

export async function createCreditMemoDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId: string;
    creditDate: string;
    memo?: string;
    taxRateId?: string | null;
    lines: SalesLineInput[];
  },
): Promise<{ id: string; number: string }> {
  return db.transaction(async (tx) => {
    await assertCustomer(tx, ctx.organizationId, input.customerId);
    const { resolved, subtotal, taxTotal, total } = await resolveLines(
      tx,
      ctx.organizationId,
      input.lines,
      input.taxRateId ?? null,
    );
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'credit_memo');
    const [credit] = await tx
      .insert(creditMemos)
      .values({
        organizationId: ctx.organizationId,
        number,
        customerId: input.customerId,
        creditDate: input.creditDate,
        memo: input.memo ?? null,
        subtotal,
        taxTotal,
        total,
        taxRateId: input.taxRateId ?? null,
      })
      .returning({ id: creditMemos.id, number: creditMemos.number });
    await tx.insert(creditMemoLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        creditMemoId: credit!.id,
        lineNumber: i + 1,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        taxable: l.taxable,
        incomeAccountId: l.incomeAccountId,
      })),
    );
    return { id: credit!.id, number: credit!.number };
  });
}

/**
 * Posting a credit memo: Dr income (returns) + Dr Sales Tax Payable,
 * Cr AR. Price-only credit — it never fabricates returned stock; inventory
 * restoration is a separate confirmed workflow (gated extension).
 */
export async function postCreditMemo(
  db: Db,
  ctx: OrgContext,
  creditMemoId: string,
  idempotencyKey: string,
  correlationId: string,
): Promise<{ journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey,
      commandType: 'credit_memo.post',
      payload: { creditMemoId },
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
      if (!credit) throw AppError.notFound('Credit memo not found');
      if (credit.postingStatus !== 'draft') {
        throw AppError.conflict('NOT_DRAFT', 'This credit memo has already been posted');
      }
      const lines = await tx
        .select()
        .from(creditMemoLines)
        .where(eq(creditMemoLines.creditMemoId, creditMemoId))
        .orderBy(creditMemoLines.lineNumber);
      const arId = await getSystemAccountId(tx, ctx.organizationId, 'accounts_receivable');
      const entryLines: PostLineInput[] = lines.map((l) => ({
        accountId: l.incomeAccountId!,
        debit: l.amount,
        partyType: 'customer' as const,
        partyId: credit.customerId,
        productId: l.productId ?? undefined,
        memo: l.description || undefined,
      }));
      if (cmp(credit.taxTotal, '0') > 0) {
        const taxId = await getSystemAccountId(tx, ctx.organizationId, 'sales_tax_payable');
        entryLines.push({ accountId: taxId, debit: credit.taxTotal });
      }
      entryLines.push({
        accountId: arId,
        credit: credit.total,
        partyType: 'customer',
        partyId: credit.customerId,
        memo: `Credit memo ${credit.number}`,
      });
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'credit_memo',
        sourceId: creditMemoId,
        postingDate: credit.creditDate,
        memo: `Credit memo ${credit.number}`,
        correlationId,
        auditAction: 'credit_memo.posted',
        auditPayload: { number: credit.number, total: credit.total },
        lines: entryLines,
      });
      await tx
        .update(creditMemos)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
          updatedAt: new Date(),
          version: credit.version + 1,
        })
        .where(eq(creditMemos.id, creditMemoId));
      return { journalEntryId: entry.id };
    },
  );
  return result;
}

/** Unapplied credit = total - allocations - refunds. */
export async function creditMemoUnapplied(
  tx: Tx,
  creditMemoId: string,
  asOf?: string,
): Promise<string> {
  const result = await tx.execute(sql`
    SELECT c.total
      - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca
                  WHERE ca.credit_memo_id = c.id
                  ${asOf ? sql`AND ca.effective_date <= ${asOf}::date` : sql``}), 0)
      - COALESCE((SELECT SUM(r.amount) FROM customer_refunds r
                  WHERE r.source_type = 'credit_memo' AND r.source_id = c.id
                  ${asOf ? sql`AND r.refund_date <= ${asOf}::date` : sql``}), 0)
      AS unapplied
    FROM credit_memos c WHERE c.id = ${creditMemoId}
  `);
  const row = result.rows[0] as { unapplied: string } | undefined;
  if (!row) throw AppError.notFound('Credit memo not found');
  return roundMoney(row.unapplied);
}

/* ------------------------------ Sales receipts --------------------------- */

export async function createAndPostSalesReceipt(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId?: string | null;
    receiptDate: string;
    depositToAccountId: string;
    memo?: string;
    taxRateId?: string | null;
    lines: SalesLineInput[];
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; number: string; journalEntryId: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'sales_receipt.create',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (input.customerId) await assertCustomer(tx, ctx.organizationId, input.customerId);
      const { resolved, subtotal, taxTotal, total } = await resolveLines(
        tx,
        ctx.organizationId,
        input.lines,
        input.taxRateId ?? null,
      );
      const number = await nextDocumentNumber(tx, ctx.organizationId, 'sales_receipt');
      const [receipt] = await tx
        .insert(salesReceipts)
        .values({
          organizationId: ctx.organizationId,
          number,
          customerId: input.customerId ?? null,
          receiptDate: input.receiptDate,
          depositToAccountId: input.depositToAccountId,
          memo: input.memo ?? null,
          subtotal,
          taxTotal,
          total,
          taxRateId: input.taxRateId ?? null,
        })
        .returning({ id: salesReceipts.id, number: salesReceipts.number });
      await tx.insert(salesReceiptLines).values(
        resolved.map((l, i) => ({
          organizationId: ctx.organizationId,
          salesReceiptId: receipt!.id,
          lineNumber: i + 1,
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          amount: l.amount,
          taxable: l.taxable,
          incomeAccountId: l.incomeAccountId,
        })),
      );

      const entryLines: PostLineInput[] = [
        { accountId: input.depositToAccountId, debit: total, memo: `Sales receipt ${number}` },
      ];
      for (const l of resolved) {
        entryLines.push({
          accountId: l.incomeAccountId,
          credit: l.amount,
          partyType: input.customerId ? 'customer' : undefined,
          partyId: input.customerId ?? undefined,
          productId: l.productId ?? undefined,
          memo: l.description || undefined,
        });
      }
      if (cmp(taxTotal, '0') > 0) {
        const taxId = await getSystemAccountId(tx, ctx.organizationId, 'sales_tax_payable');
        entryLines.push({ accountId: taxId, credit: taxTotal });
      }
      let totalCogs = '0';
      for (const l of resolved) {
        if (l.productType !== 'inventory' || !l.productId) continue;
        const { totalCost } = await consumeFifo(tx, {
          organizationId: ctx.organizationId,
          productId: l.productId,
          quantity: l.quantity,
          sourceType: 'sales_receipt',
          sourceId: receipt!.id,
        });
        totalCogs = add(totalCogs, totalCost);
      }
      if (cmp(totalCogs, '0') > 0) {
        const cogsId = await getSystemAccountId(tx, ctx.organizationId, 'cogs');
        const inventoryId = await getSystemAccountId(tx, ctx.organizationId, 'inventory_asset');
        entryLines.push({ accountId: cogsId, debit: roundMoney(totalCogs) });
        entryLines.push({ accountId: inventoryId, credit: roundMoney(totalCogs) });
      }
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'sales_receipt',
        sourceId: receipt!.id,
        postingDate: input.receiptDate,
        memo: `Sales receipt ${number}`,
        correlationId,
        auditAction: 'sales_receipt.posted',
        auditPayload: { number, total },
        lines: entryLines,
      });
      await tx
        .update(salesReceipts)
        .set({
          postingStatus: 'posted',
          journalEntryId: entry.id,
          postedAt: new Date(),
          postedByUserId: ctx.userId,
        })
        .where(eq(salesReceipts.id, receipt!.id));
      return { id: receipt!.id, number, journalEntryId: entry.id };
    },
  );
  return result;
}

/* -------------------------------- Estimates ------------------------------ */

export async function createEstimateDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    customerId: string;
    estimateDate: string;
    expirationDate?: string | null;
    memo?: string;
    customerMessage?: string;
    taxRateId?: string | null;
    lines: SalesLineInput[];
  },
): Promise<{ id: string; number: string }> {
  return db.transaction(async (tx) => {
    await assertCustomer(tx, ctx.organizationId, input.customerId);
    const { resolved, subtotal, taxTotal, total } = await resolveLines(
      tx,
      ctx.organizationId,
      input.lines,
      input.taxRateId ?? null,
    );
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'estimate');
    const [estimate] = await tx
      .insert(estimates)
      .values({
        organizationId: ctx.organizationId,
        number,
        customerId: input.customerId,
        estimateDate: input.estimateDate,
        expirationDate: input.expirationDate ?? null,
        memo: input.memo ?? null,
        customerMessage: input.customerMessage ?? null,
        subtotal,
        taxTotal,
        total,
        taxRateId: input.taxRateId ?? null,
        createdByUserId: ctx.userId,
      })
      .returning({ id: estimates.id, number: estimates.number });
    await tx.insert(estimateLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        estimateId: estimate!.id,
        lineNumber: i + 1,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
        taxable: l.taxable,
      })),
    );
    return { id: estimate!.id, number: estimate!.number };
  });
}

const ESTIMATE_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent', 'accepted', 'rejected', 'closed'],
  sent: ['accepted', 'rejected', 'expired', 'closed'],
  accepted: ['closed'],
  rejected: ['closed'],
  expired: ['sent', 'closed'],
  partially_converted: ['converted', 'closed'],
  converted: [],
  closed: [],
};

export async function transitionEstimate(
  db: Db,
  ctx: OrgContext,
  estimateId: string,
  input: { status: string; acceptedByName?: string; acceptedSource?: string },
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [estimate] = await tx
      .select()
      .from(estimates)
      .where(and(eq(estimates.id, estimateId), eq(estimates.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!estimate) throw AppError.notFound('Estimate not found');
    const allowed = ESTIMATE_TRANSITIONS[estimate.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `An estimate in status "${estimate.status}" cannot move to "${input.status}"`,
      );
    }
    await tx
      .update(estimates)
      .set({
        status: input.status as typeof estimate.status,
        ...(input.status === 'accepted'
          ? {
              acceptedAt: new Date(),
              acceptedByName: input.acceptedByName ?? null,
              acceptedSource: input.acceptedSource ?? 'manual',
            }
          : {}),
        updatedAt: new Date(),
        version: estimate.version + 1,
      })
      .where(eq(estimates.id, estimateId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: `estimate.${input.status}`,
      entityType: 'estimate',
      entityId: estimateId,
      payload: { number: estimate.number },
      correlationId,
    });
  });
}

/**
 * Converts all or selected estimate quantities into a draft invoice while
 * tracking converted quantities and conversion lineage.
 */
export async function convertEstimateToInvoice(
  db: Db,
  ctx: OrgContext,
  estimateId: string,
  input: {
    invoiceDate: string;
    selections?: { estimateLineId: string; quantity: string }[];
  },
  _correlationId: string,
): Promise<{ invoiceId: string; invoiceNumber: string }> {
  return db.transaction(async (tx) => {
    const [estimate] = await tx
      .select()
      .from(estimates)
      .where(and(eq(estimates.id, estimateId), eq(estimates.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!estimate) throw AppError.notFound('Estimate not found');
    if (!['accepted', 'sent', 'partially_converted', 'draft'].includes(estimate.status)) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `An estimate in status "${estimate.status}" cannot be converted`,
      );
    }
    const lines = await tx
      .select()
      .from(estimateLines)
      .where(eq(estimateLines.estimateId, estimateId))
      .orderBy(estimateLines.lineNumber)
      .for('update');

    const picks =
      input.selections ??
      lines
        .filter((l) => cmp(sub(l.quantity, l.convertedQuantity), '0') > 0)
        .map((l) => ({
          estimateLineId: l.id,
          quantity: sub(l.quantity, l.convertedQuantity),
        }));
    if (picks.length === 0) {
      throw AppError.unprocessable('NOTHING_TO_CONVERT', 'Every line is already fully invoiced');
    }
    const byId = new Map(lines.map((l) => [l.id, l]));
    const invoiceLinesInput: SalesLineInput[] = [];
    for (const pick of picks) {
      const line = byId.get(pick.estimateLineId);
      if (!line) throw AppError.validation('Unknown estimate line in selection');
      const remaining = sub(line.quantity, line.convertedQuantity);
      if (cmp(pick.quantity, '0') <= 0 || cmp(pick.quantity, remaining) > 0) {
        throw AppError.unprocessable(
          'OVERBILLING_BLOCKED',
          `Line ${line.lineNumber} has only ${remaining} unbilled; requested ${pick.quantity}`,
        );
      }
      invoiceLinesInput.push({
        productId: line.productId,
        description: line.description,
        quantity: pick.quantity,
        unitPrice: line.unitPrice,
        taxable: line.taxable,
        estimateLineId: line.id,
      });
      await tx
        .update(estimateLines)
        .set({ convertedQuantity: add(line.convertedQuantity, pick.quantity) })
        .where(eq(estimateLines.id, line.id));
    }

    const draft = await createInvoiceDraftInTx(tx, ctx, {
      customerId: estimate.customerId,
      invoiceDate: input.invoiceDate,
      taxRateId: estimate.taxRateId,
      estimateId,
      memo: `From estimate ${estimate.number}`,
      lines: invoiceLinesInput,
    });

    const refreshed = await tx
      .select()
      .from(estimateLines)
      .where(eq(estimateLines.estimateId, estimateId));
    const fullyConverted = refreshed.every(
      (l) => cmp(sub(l.quantity, l.convertedQuantity), '0') <= 0,
    );
    await tx
      .update(estimates)
      .set({
        status: fullyConverted ? 'converted' : 'partially_converted',
        updatedAt: new Date(),
        version: estimate.version + 1,
      })
      .where(eq(estimates.id, estimateId));
    return { invoiceId: draft.id, invoiceNumber: draft.number };
  });
}

/** In-transaction variant used by estimate conversion. */
async function createInvoiceDraftInTx(
  tx: Tx,
  ctx: OrgContext,
  input: {
    customerId: string;
    invoiceDate: string;
    taxRateId?: string | null;
    estimateId?: string | null;
    memo?: string;
    lines: SalesLineInput[];
  },
): Promise<{ id: string; number: string }> {
  const customer = await assertCustomer(tx, ctx.organizationId, input.customerId);
  const { resolved, subtotal, taxTotal, total } = await resolveLines(
    tx,
    ctx.organizationId,
    input.lines,
    input.taxRateId ?? null,
  );
  const termsDays = customer.termsDays ?? 30;
  const number = await nextDocumentNumber(tx, ctx.organizationId, 'invoice');
  const [invoice] = await tx
    .insert(invoices)
    .values({
      organizationId: ctx.organizationId,
      number,
      customerId: input.customerId,
      estimateId: input.estimateId ?? null,
      invoiceDate: input.invoiceDate,
      dueDate: addDaysISO(input.invoiceDate, termsDays),
      termsDays,
      memo: input.memo ?? null,
      subtotal,
      taxTotal,
      total,
      taxRateId: input.taxRateId ?? null,
      createdByUserId: ctx.userId,
    })
    .returning({ id: invoices.id, number: invoices.number });
  await tx.insert(invoiceLines).values(
    resolved.map((l, i) => ({
      organizationId: ctx.organizationId,
      invoiceId: invoice!.id,
      lineNumber: i + 1,
      productId: l.productId,
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      amount: l.amount,
      taxable: l.taxable,
      incomeAccountId: l.incomeAccountId,
      estimateLineId: l.estimateLineId,
    })),
  );
  return { id: invoice!.id, number: invoice!.number };
}

export { sum as sumMoney };
