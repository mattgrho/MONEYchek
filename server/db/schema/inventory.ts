import { bigint, date, index, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations } from './core';
import { journalEntries } from './ledger';
import { productsServices } from './sales';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/**
 * Perpetual FIFO inventory subledger. The UI for inventory is a gated
 * extension; the subledger exists so the posting engine and the mandatory
 * golden-dataset fixtures exercise the full accounting model.
 *
 * Invariant: Inventory Asset GL balance == SUM(remaining_value) at all times.
 */
export const inventoryLayers = pgTable(
  'inventory_layers',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsServices.id),
    receiptDate: date('receipt_date').notNull(),
    /** Deterministic FIFO tie-break within the same receipt date. */
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    originalQuantity: numeric('original_quantity', { precision: 20, scale: 6 }).notNull(),
    remainingQuantity: numeric('remaining_quantity', { precision: 20, scale: 6 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 20, scale: 6 }).notNull(),
    originalValue: numeric('original_value', { precision: 20, scale: 4 }).notNull(),
    remainingValue: numeric('remaining_value', { precision: 20, scale: 4 }).notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_layers_fifo_idx').on(t.organizationId, t.productId, t.receiptDate, t.sequence),
  ],
);

export const inventoryConsumptions = pgTable(
  'inventory_consumptions',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    layerId: uuid('layer_id')
      .notNull()
      .references(() => inventoryLayers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsServices.id),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull(),
    cost: numeric('cost', { precision: 20, scale: 4 }).notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    reversalOfConsumptionId: uuid('reversal_of_consumption_id'),
    createdAt: createdAt(),
  },
  (t) => [
    index('inventory_consumptions_org_product_idx').on(t.organizationId, t.productId),
    index('inventory_consumptions_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
  ],
);

/**
 * Manual quantity adjustments (shrinkage, counts, found stock). Each row is
 * one posted adjustment: increases create a new FIFO layer at the given
 * unit cost, decreases consume FIFO layers; both post against the protected
 * Inventory Adjustments account.
 */
export const inventoryAdjustments = pgTable(
  'inventory_adjustments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => productsServices.id),
    adjustmentDate: date('adjustment_date').notNull(),
    direction: text('direction', { enum: ['increase', 'decrease'] }).notNull(),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull(),
    /** Unit cost for increases; null for decreases (FIFO decides the cost). */
    unitCost: numeric('unit_cost', { precision: 20, scale: 6 }),
    totalValue: numeric('total_value', { precision: 20, scale: 4 }).notNull(),
    reason: text('reason').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('inventory_adjustments_org_product_idx').on(t.organizationId, t.productId)],
);
