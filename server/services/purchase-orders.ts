import { and, eq } from 'drizzle-orm';
import { add, cmp, isDecimalString, mul, roundMoney, sub, sum } from '@shared/money';
import type { Db } from '../db/client';
import {
  accounts,
  productsServices,
  purchaseOrderLines,
  purchaseOrders,
  vendors,
} from '../db/schema/index';
import { AppError } from '../lib/errors';
import { nextDocumentNumber } from '../accounting/sequences';
import { writeAuditEvent } from '../accounting/audit';
import type { OrgContext } from './identity';
import { createBillDraftInTx, type BillLineInput } from './bills';

/**
 * Purchase orders: vendor commitments that never touch the ledger. The only
 * accounting event is conversion, which creates an ordinary bill draft and
 * advances each PO line's billed quantity (overbilling blocked, partial
 * conversion supported — the same discipline as estimate → invoice).
 */

export interface PoLineInput {
  productId?: string | null;
  accountId?: string | null;
  description?: string;
  quantity: string;
  unitCost: string;
}

interface ResolvedPoLine {
  productId: string | null;
  accountId: string | null;
  description: string;
  quantity: string;
  unitCost: string;
  amount: string;
}

async function resolvePoLines(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  organizationId: string,
  lines: PoLineInput[],
): Promise<{ resolved: ResolvedPoLine[]; total: string }> {
  if (lines.length === 0) throw AppError.validation('At least one line is required');
  const resolved: ResolvedPoLine[] = [];
  for (const line of lines) {
    if (
      !isDecimalString(line.quantity) ||
      !isDecimalString(line.unitCost) ||
      cmp(line.quantity, '0') <= 0 ||
      cmp(line.unitCost, '0') < 0
    ) {
      throw AppError.validation('Each line needs a positive quantity and a non-negative cost');
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
      if (!p) throw AppError.validation('Unknown product on a line');
      product = p;
    }
    let accountId = line.accountId ?? null;
    if (!accountId && product) accountId = product.expenseAccountId;
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
    if (!accountId && product?.type !== 'inventory') {
      throw AppError.validation(
        'Each line needs an account (or a product with an expense account)',
      );
    }
    resolved.push({
      productId: product?.id ?? null,
      accountId,
      description: line.description ?? product?.purchaseDescription ?? product?.name ?? '',
      quantity: line.quantity,
      unitCost: line.unitCost,
      amount: roundMoney(mul(line.quantity, line.unitCost)),
    });
  }
  return { resolved, total: roundMoney(sum(resolved.map((l) => l.amount))) };
}

export async function createPurchaseOrderDraft(
  db: Db,
  ctx: OrgContext,
  input: {
    vendorId: string;
    poDate: string;
    expectedDate?: string | null;
    shipTo?: string | null;
    memo?: string;
    vendorMessage?: string;
    lines: PoLineInput[];
  },
): Promise<{ id: string; number: string }> {
  return db.transaction(async (tx) => {
    const [vendor] = await tx
      .select()
      .from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.organizationId, ctx.organizationId)))
      .limit(1);
    if (!vendor) throw AppError.validation('Unknown vendor');
    const { resolved, total } = await resolvePoLines(tx, ctx.organizationId, input.lines);
    const number = await nextDocumentNumber(tx, ctx.organizationId, 'purchase_order');
    const [po] = await tx
      .insert(purchaseOrders)
      .values({
        organizationId: ctx.organizationId,
        number,
        vendorId: input.vendorId,
        poDate: input.poDate,
        expectedDate: input.expectedDate ?? null,
        shipTo: input.shipTo ?? null,
        memo: input.memo ?? null,
        vendorMessage: input.vendorMessage ?? null,
        total,
        createdByUserId: ctx.userId,
      })
      .returning({ id: purchaseOrders.id, number: purchaseOrders.number });
    await tx.insert(purchaseOrderLines).values(
      resolved.map((l, i) => ({
        organizationId: ctx.organizationId,
        purchaseOrderId: po!.id,
        lineNumber: i + 1,
        productId: l.productId,
        accountId: l.accountId,
        description: l.description,
        quantity: l.quantity,
        unitCost: l.unitCost,
        amount: l.amount,
      })),
    );
    return { id: po!.id, number: po!.number };
  });
}

export async function updatePurchaseOrderDraft(
  db: Db,
  ctx: OrgContext,
  poId: string,
  input: {
    poDate?: string;
    expectedDate?: string | null;
    shipTo?: string | null;
    memo?: string | null;
    vendorMessage?: string | null;
    lines?: PoLineInput[];
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    if (po.status !== 'draft') {
      throw AppError.conflict('NOT_DRAFT', 'Only draft purchase orders can be edited');
    }
    let total = po.total;
    if (input.lines) {
      const { resolved, total: newTotal } = await resolvePoLines(
        tx,
        ctx.organizationId,
        input.lines,
      );
      await tx.delete(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, poId));
      await tx.insert(purchaseOrderLines).values(
        resolved.map((l, i) => ({
          organizationId: ctx.organizationId,
          purchaseOrderId: poId,
          lineNumber: i + 1,
          productId: l.productId,
          accountId: l.accountId,
          description: l.description,
          quantity: l.quantity,
          unitCost: l.unitCost,
          amount: l.amount,
        })),
      );
      total = newTotal;
    }
    await tx
      .update(purchaseOrders)
      .set({
        poDate: input.poDate ?? po.poDate,
        expectedDate: input.expectedDate === undefined ? po.expectedDate : input.expectedDate,
        shipTo: input.shipTo === undefined ? po.shipTo : input.shipTo,
        memo: input.memo === undefined ? po.memo : input.memo,
        vendorMessage:
          input.vendorMessage === undefined ? po.vendorMessage : input.vendorMessage,
        total,
        version: po.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, poId));
  });
}

const TRANSITIONS: Record<string, string[]> = {
  draft: ['open', 'canceled'],
  open: ['closed', 'canceled'],
  partially_billed: ['closed'],
  billed: [],
  closed: [],
  canceled: [],
};

export async function transitionPurchaseOrder(
  db: Db,
  ctx: OrgContext,
  poId: string,
  to: 'open' | 'closed' | 'canceled',
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    if (!TRANSITIONS[po.status]?.includes(to)) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `A purchase order in status "${po.status}" cannot become "${to}"`,
      );
    }
    await tx
      .update(purchaseOrders)
      .set({ status: to, version: po.version + 1, updatedAt: new Date() })
      .where(eq(purchaseOrders.id, poId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: `purchase_order.${to}`,
      entityType: 'purchase_order',
      entityId: poId,
      payload: { number: po.number, from: po.status },
      correlationId,
    });
  });
}

export async function convertPurchaseOrderToBill(
  db: Db,
  ctx: OrgContext,
  poId: string,
  input: {
    billDate: string;
    vendorReference?: string;
    selections?: { poLineId: string; quantity: string }[];
  },
  correlationId: string,
): Promise<{ billId: string; billNumber: string }> {
  return db.transaction(async (tx) => {
    const [po] = await tx
      .select()
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.organizationId, ctx.organizationId)))
      .for('update')
      .limit(1);
    if (!po) throw AppError.notFound('Purchase order not found');
    if (!['open', 'partially_billed'].includes(po.status)) {
      throw AppError.conflict(
        'INVALID_TRANSITION',
        `A purchase order in status "${po.status}" cannot be billed (open it first)`,
      );
    }
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poId))
      .orderBy(purchaseOrderLines.lineNumber)
      .for('update');

    const picks =
      input.selections ??
      lines
        .filter((l) => cmp(sub(l.quantity, l.billedQuantity), '0') > 0)
        .map((l) => ({ poLineId: l.id, quantity: sub(l.quantity, l.billedQuantity) }));
    if (picks.length === 0) {
      throw AppError.unprocessable('NOTHING_TO_CONVERT', 'Every line is already fully billed');
    }
    const byId = new Map(lines.map((l) => [l.id, l]));
    const billLinesInput: BillLineInput[] = [];
    for (const pick of picks) {
      const line = byId.get(pick.poLineId);
      if (!line) throw AppError.validation('Unknown purchase order line in selection');
      const remaining = sub(line.quantity, line.billedQuantity);
      if (
        !isDecimalString(pick.quantity) ||
        cmp(pick.quantity, '0') <= 0 ||
        cmp(pick.quantity, remaining) > 0
      ) {
        throw AppError.unprocessable(
          'OVERBILLING_BLOCKED',
          `Line ${line.lineNumber} has only ${remaining} unbilled; requested ${pick.quantity}`,
        );
      }
      billLinesInput.push({
        productId: line.productId,
        accountId: line.accountId,
        description: line.description,
        quantity: pick.quantity,
        unitCost: line.unitCost,
      });
      await tx
        .update(purchaseOrderLines)
        .set({ billedQuantity: add(line.billedQuantity, pick.quantity) })
        .where(eq(purchaseOrderLines.id, line.id));
    }

    const bill = await createBillDraftInTx(tx, ctx, {
      vendorId: po.vendorId,
      billDate: input.billDate,
      vendorReference: input.vendorReference,
      memo: `From purchase order ${po.number}`,
      lines: billLinesInput,
      purchaseOrderId: poId,
    });

    const refreshed = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, poId));
    const fullyBilled = refreshed.every((l) => cmp(sub(l.quantity, l.billedQuantity), '0') <= 0);
    await tx
      .update(purchaseOrders)
      .set({
        status: fullyBilled ? 'billed' : 'partially_billed',
        version: po.version + 1,
        updatedAt: new Date(),
      })
      .where(eq(purchaseOrders.id, poId));
    await writeAuditEvent(tx, {
      organizationId: ctx.organizationId,
      actorUserId: ctx.userId,
      actorRole: ctx.roleKey,
      action: 'purchase_order.converted',
      entityType: 'purchase_order',
      entityId: poId,
      payload: { number: po.number, billId: bill.id, billNumber: bill.number },
      correlationId,
    });
    return { billId: bill.id, billNumber: bill.number };
  });
}
