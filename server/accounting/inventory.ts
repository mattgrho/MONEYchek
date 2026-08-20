import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { inventoryConsumptions, inventoryLayers } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { add, cmp, min as decMin, mul, neg, roundMoney, sub } from '@shared/money';

/**
 * Perpetual FIFO inventory subledger. UI exposure is gated, but the model is
 * complete because posted documents (bills, invoices, credits) may carry
 * inventory products and the golden dataset exercises it.
 *
 * Invariant: Inventory Asset GL balance == SUM(remaining_value).
 * Negative inventory is rejected (default policy).
 */

let sequenceCounter = 0;

export async function receiveInventory(
  tx: Tx,
  input: {
    organizationId: string;
    productId: string;
    receiptDate: string;
    quantity: string;
    unitCost: string;
    sourceType: string;
    sourceId?: string | null;
    journalEntryId?: string | null;
  },
): Promise<{ layerId: string; value: string }> {
  if (cmp(input.quantity, '0') <= 0) {
    throw AppError.unprocessable('INVALID_QUANTITY', 'Receipt quantity must be positive');
  }
  const value = roundMoney(mul(input.quantity, input.unitCost));
  // Deterministic tie-break inside a date: microsecond timestamp + counter.
  const sequence = Date.now() * 1000 + (sequenceCounter++ % 1000);
  const [layer] = await tx
    .insert(inventoryLayers)
    .values({
      organizationId: input.organizationId,
      productId: input.productId,
      receiptDate: input.receiptDate,
      sequence,
      sourceType: input.sourceType,
      sourceId: input.sourceId ?? null,
      originalQuantity: input.quantity,
      remainingQuantity: input.quantity,
      unitCost: input.unitCost,
      originalValue: value,
      remainingValue: value,
      journalEntryId: input.journalEntryId ?? null,
    })
    .returning({ id: inventoryLayers.id });
  return { layerId: layer!.id, value };
}

export interface FifoConsumption {
  consumptionId: string;
  layerId: string;
  quantity: string;
  cost: string;
}

/**
 * Consumes oldest layers first, atomically (rows locked FOR UPDATE). COGS is
 * exactly the consumed layer cost; the final layer's consumption cost is the
 * remainder of its value when fully drained so values never drift.
 */
export async function consumeFifo(
  tx: Tx,
  input: {
    organizationId: string;
    productId: string;
    quantity: string;
    sourceType: string;
    sourceId?: string | null;
    journalEntryId?: string | null;
  },
): Promise<{ totalCost: string; consumptions: FifoConsumption[] }> {
  if (cmp(input.quantity, '0') <= 0) {
    throw AppError.unprocessable('INVALID_QUANTITY', 'Consumption quantity must be positive');
  }
  const layers = await tx
    .select()
    .from(inventoryLayers)
    .where(
      and(
        eq(inventoryLayers.organizationId, input.organizationId),
        eq(inventoryLayers.productId, input.productId),
      ),
    )
    .orderBy(asc(inventoryLayers.receiptDate), asc(inventoryLayers.sequence))
    .for('update');

  let remaining = input.quantity;
  let totalCost = '0';
  const consumptions: FifoConsumption[] = [];
  for (const layer of layers) {
    if (cmp(remaining, '0') === 0) break;
    if (cmp(layer.remainingQuantity, '0') <= 0) continue;
    const take = decMin(remaining, layer.remainingQuantity);
    const drainsLayer = cmp(take, layer.remainingQuantity) === 0;
    const cost = drainsLayer ? layer.remainingValue : roundMoney(mul(take, layer.unitCost));
    const newQty = sub(layer.remainingQuantity, take);
    const newValue = sub(layer.remainingValue, cost);
    await tx
      .update(inventoryLayers)
      .set({ remainingQuantity: newQty, remainingValue: newValue })
      .where(eq(inventoryLayers.id, layer.id));
    const [consumption] = await tx
      .insert(inventoryConsumptions)
      .values({
        organizationId: input.organizationId,
        layerId: layer.id,
        productId: input.productId,
        quantity: take,
        cost,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        journalEntryId: input.journalEntryId ?? null,
      })
      .returning({ id: inventoryConsumptions.id });
    consumptions.push({ consumptionId: consumption!.id, layerId: layer.id, quantity: take, cost });
    totalCost = add(totalCost, cost);
    remaining = sub(remaining, take);
  }
  if (cmp(remaining, '0') > 0) {
    throw AppError.unprocessable(
      'INSUFFICIENT_INVENTORY',
      `Not enough stock on hand (short ${remaining}); negative inventory is not allowed`,
    );
  }
  return { totalCost: roundMoney(totalCost), consumptions };
}

/**
 * Restores earlier consumptions (used by void with confirmed physical
 * return). Quantities/values return to their ORIGINAL layers at original
 * cost; reversal consumption rows keep full lineage.
 */
export async function restoreConsumptions(
  tx: Tx,
  organizationId: string,
  sourceType: string,
  sourceId: string,
): Promise<{ restoredCost: string }> {
  const rows = await tx
    .select()
    .from(inventoryConsumptions)
    .where(
      and(
        eq(inventoryConsumptions.organizationId, organizationId),
        eq(inventoryConsumptions.sourceType, sourceType),
        eq(inventoryConsumptions.sourceId, sourceId),
      ),
    );
  let restored = '0';
  for (const row of rows) {
    if (row.reversalOfConsumptionId) continue; // already a reversal row
    // Skip if already reversed.
    const [existingReversal] = await tx
      .select({ id: inventoryConsumptions.id })
      .from(inventoryConsumptions)
      .where(eq(inventoryConsumptions.reversalOfConsumptionId, row.id))
      .limit(1);
    if (existingReversal) continue;
    const [layer] = await tx
      .select()
      .from(inventoryLayers)
      .where(eq(inventoryLayers.id, row.layerId))
      .for('update')
      .limit(1);
    if (!layer) throw AppError.internal('Inventory layer missing');
    await tx
      .update(inventoryLayers)
      .set({
        remainingQuantity: add(layer.remainingQuantity, row.quantity),
        remainingValue: add(layer.remainingValue, row.cost),
      })
      .where(eq(inventoryLayers.id, layer.id));
    await tx.insert(inventoryConsumptions).values({
      organizationId,
      layerId: layer.id,
      productId: row.productId,
      quantity: neg(row.quantity),
      cost: neg(row.cost),
      sourceType: `${sourceType}_void`,
      sourceId,
      reversalOfConsumptionId: row.id,
    });
    restored = add(restored, row.cost);
  }
  return { restoredCost: roundMoney(restored) };
}

/** Quantity/value on hand for a product. */
export async function inventoryOnHand(
  tx: Tx,
  organizationId: string,
  productId: string,
): Promise<{ quantity: string; value: string }> {
  const layers = await tx
    .select({ q: inventoryLayers.remainingQuantity, v: inventoryLayers.remainingValue })
    .from(inventoryLayers)
    .where(
      and(
        eq(inventoryLayers.organizationId, organizationId),
        eq(inventoryLayers.productId, productId),
      ),
    );
  let q = '0';
  let v = '0';
  for (const layer of layers) {
    q = add(q, layer.q);
    v = add(v, layer.v);
  }
  return { quantity: q, value: roundMoney(v) };
}
