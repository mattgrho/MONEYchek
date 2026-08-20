import { and, desc, eq, sql } from 'drizzle-orm';
import { cmp, isDecimalString, mul, roundMoney } from '@shared/money';
import type { Db, DbOrTx } from '../db/client';
import { inventoryAdjustments, productsServices, users } from '../db/schema/index';
import { AppError } from '../lib/errors';
import { runFinancialCommand } from '../accounting/idempotency';
import { postEntry } from '../accounting/posting';
import { getSystemAccountId } from '../accounting/accounts';
import { consumeFifo, receiveInventory } from '../accounting/inventory';
import { formatQuantityForApi } from '../lib/format';
import type { OrgContext } from './identity';

/**
 * Manual inventory adjustments over the perpetual FIFO subledger.
 * Increase: new layer at the stated unit cost — Dr Inventory Asset,
 * Cr Inventory Adjustments. Decrease: FIFO consumption at layer cost —
 * Dr Inventory Adjustments, Cr Inventory Asset. Negative stock is rejected
 * by the subledger itself.
 */
export async function adjustInventory(
  db: Db,
  ctx: OrgContext,
  input: {
    productId: string;
    adjustmentDate: string;
    direction: 'increase' | 'decrease';
    quantity: string;
    unitCost?: string;
    reason: string;
    idempotencyKey: string;
  },
  correlationId: string,
): Promise<{ id: string; journalEntryId: string; totalValue: string }> {
  const { result } = await runFinancialCommand(
    db,
    {
      organizationId: ctx.organizationId,
      idempotencyKey: input.idempotencyKey,
      commandType: 'inventory.adjust',
      payload: input,
      actorUserId: ctx.userId,
    },
    async (tx) => {
      if (!isDecimalString(input.quantity) || cmp(input.quantity, '0') <= 0) {
        throw AppError.validation('Adjustment quantity must be positive');
      }
      const [product] = await tx
        .select()
        .from(productsServices)
        .where(
          and(
            eq(productsServices.id, input.productId),
            eq(productsServices.organizationId, ctx.organizationId),
          ),
        )
        .limit(1);
      if (!product) throw AppError.validation('Unknown product');
      if (product.type !== 'inventory') {
        throw AppError.unprocessable(
          'NOT_INVENTORY',
          'Quantity adjustments only apply to inventory-type products',
        );
      }

      const inventoryAssetId = await getSystemAccountId(tx, ctx.organizationId, 'inventory_asset');
      const adjustmentId = await getSystemAccountId(tx, ctx.organizationId, 'inventory_adjustment');

      let totalValue: string;
      let unitCost: string | null = null;
      if (input.direction === 'increase') {
        if (!input.unitCost || !isDecimalString(input.unitCost) || cmp(input.unitCost, '0') <= 0) {
          throw AppError.validation('An increase needs a positive unit cost');
        }
        unitCost = input.unitCost;
        totalValue = roundMoney(mul(input.quantity, input.unitCost));
      } else {
        // Peek is unnecessary: consumeFifo computes exact layer cost and
        // rejects negative stock. We post after we know the exact value, so
        // consume first, then post, then link the entry.
        totalValue = '0';
      }

      if (input.direction === 'increase') {
        const entry = await postEntry(tx, {
          organizationId: ctx.organizationId,
          actorUserId: ctx.userId,
          actorRole: ctx.roleKey,
          sourceType: 'inventory_adjustment',
          sourceId: input.productId,
          postingDate: input.adjustmentDate,
          memo: `Inventory adjustment: ${product.name} +${input.quantity}`,
          correlationId,
          auditAction: 'inventory.adjusted',
          auditPayload: {
            product: product.name,
            direction: 'increase',
            quantity: input.quantity,
            totalValue,
            reason: input.reason,
          },
          lines: [
            { accountId: inventoryAssetId, debit: totalValue, memo: input.reason },
            { accountId: adjustmentId, credit: totalValue, memo: input.reason },
          ],
        });
        await receiveInventory(tx, {
          organizationId: ctx.organizationId,
          productId: input.productId,
          receiptDate: input.adjustmentDate,
          quantity: input.quantity,
          unitCost: input.unitCost!,
          sourceType: 'inventory_adjustment',
          sourceId: null,
          journalEntryId: entry.id,
        });
        const [row] = await tx
          .insert(inventoryAdjustments)
          .values({
            organizationId: ctx.organizationId,
            productId: input.productId,
            adjustmentDate: input.adjustmentDate,
            direction: 'increase',
            quantity: input.quantity,
            unitCost,
            totalValue,
            reason: input.reason,
            journalEntryId: entry.id,
            createdByUserId: ctx.userId,
          })
          .returning({ id: inventoryAdjustments.id });
        return { id: row!.id, journalEntryId: entry.id, totalValue };
      }

      const { totalCost } = await consumeFifo(tx, {
        organizationId: ctx.organizationId,
        productId: input.productId,
        quantity: input.quantity,
        sourceType: 'inventory_adjustment',
        sourceId: null,
      });
      totalValue = roundMoney(totalCost);
      const entry = await postEntry(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        sourceType: 'inventory_adjustment',
        sourceId: input.productId,
        postingDate: input.adjustmentDate,
        memo: `Inventory adjustment: ${product.name} -${input.quantity}`,
        correlationId,
        auditAction: 'inventory.adjusted',
        auditPayload: {
          product: product.name,
          direction: 'decrease',
          quantity: input.quantity,
          totalValue,
          reason: input.reason,
        },
        lines: [
          { accountId: adjustmentId, debit: totalValue, memo: input.reason },
          { accountId: inventoryAssetId, credit: totalValue, memo: input.reason },
        ],
      });
      const [row] = await tx
        .insert(inventoryAdjustments)
        .values({
          organizationId: ctx.organizationId,
          productId: input.productId,
          adjustmentDate: input.adjustmentDate,
          direction: 'decrease',
          quantity: input.quantity,
          unitCost: null,
          totalValue,
          reason: input.reason,
          journalEntryId: entry.id,
          createdByUserId: ctx.userId,
        })
        .returning({ id: inventoryAdjustments.id });
      return { id: row!.id, journalEntryId: entry.id, totalValue };
    },
  );
  return result;
}

export interface InventoryValuationRow {
  productId: string;
  name: string;
  sku: string | null;
  unitLabel: string | null;
  quantityOnHand: string;
  value: string;
  averageCost: string;
}

/**
 * Point-in-time (now) valuation from remaining FIFO layers, with the GL
 * tie-out asserted in the payload rather than assumed.
 */
export async function inventoryValuation(
  db: DbOrTx,
  organizationId: string,
): Promise<{
  rows: InventoryValuationRow[];
  totalValue: string;
  ledgerBalance: string;
  tiesToLedger: boolean;
}> {
  const result = await db.execute(sql`
    SELECT p.id AS product_id, p.name, p.sku, p.unit_label,
           COALESCE(SUM(l.remaining_quantity), 0)::text AS quantity,
           COALESCE(SUM(l.remaining_value), 0)::text AS value
    FROM products_services p
    LEFT JOIN inventory_layers l ON l.product_id = p.id
    WHERE p.organization_id = ${organizationId} AND p.type = 'inventory'
    GROUP BY p.id
    ORDER BY p.name
  `);
  const glResult = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
    FROM journal_lines jl
    JOIN accounts a ON a.id = jl.account_id
    WHERE jl.organization_id = ${organizationId} AND a.system_key = 'inventory_asset'
  `);
  interface Row {
    product_id: string;
    name: string;
    sku: string | null;
    unit_label: string | null;
    quantity: string;
    value: string;
  }
  const { add, div } = await import('@shared/money');
  let total = '0';
  const rows = (result.rows as unknown as Row[]).map((r) => {
    const value = roundMoney(r.value);
    total = add(total, value);
    const qtyNumeric = formatQuantityForApi(r.quantity);
    return {
      productId: r.product_id,
      name: r.name,
      sku: r.sku,
      unitLabel: r.unit_label,
      quantityOnHand: qtyNumeric,
      value,
      averageCost: cmp(r.quantity, '0') > 0 ? roundMoney(div(value, r.quantity)) : '0.00',
    };
  });
  const ledgerBalance = roundMoney((glResult.rows[0] as { balance: string }).balance);
  const totalValue = roundMoney(total);
  return { rows, totalValue, ledgerBalance, tiesToLedger: totalValue === ledgerBalance };
}

/** Recent adjustments with product and actor names for the UI. */
export async function listInventoryAdjustments(db: Db, organizationId: string, limit = 100) {
  return db
    .select({
      id: inventoryAdjustments.id,
      productId: inventoryAdjustments.productId,
      productName: productsServices.name,
      adjustmentDate: inventoryAdjustments.adjustmentDate,
      direction: inventoryAdjustments.direction,
      quantity: inventoryAdjustments.quantity,
      unitCost: inventoryAdjustments.unitCost,
      totalValue: inventoryAdjustments.totalValue,
      reason: inventoryAdjustments.reason,
      journalEntryId: inventoryAdjustments.journalEntryId,
      createdByName: users.name,
      createdAt: inventoryAdjustments.createdAt,
    })
    .from(inventoryAdjustments)
    .innerJoin(productsServices, eq(inventoryAdjustments.productId, productsServices.id))
    .leftJoin(users, eq(inventoryAdjustments.createdByUserId, users.id))
    .where(eq(inventoryAdjustments.organizationId, organizationId))
    .orderBy(desc(inventoryAdjustments.createdAt))
    .limit(limit);
}
