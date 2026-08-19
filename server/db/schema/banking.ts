import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './core';
import { accounts, journalEntries, journalLines } from './ledger';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

/** Institution/display metadata for ledger bank & credit-card accounts. */
export const financialAccountMetadata = pgTable(
  'financial_account_metadata',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    kind: text('kind', { enum: ['bank', 'credit_card'] }).notNull(),
    institutionName: text('institution_name'),
    accountMask: text('account_mask'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('fam_account_uq').on(t.accountId)],
);

export const bankImportBatches = pgTable(
  'bank_import_batches',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    filename: text('filename').notNull(),
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
    rowCount: integer('row_count').notNull().default(0),
    importedCount: integer('imported_count').notNull().default(0),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    errors: jsonb('errors').$type<{ row: number; message: string }[]>().notNull().default([]),
    status: text('status', { enum: ['dry_run', 'completed', 'failed'] })
      .notNull()
      .default('dry_run'),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('bank_import_batches_org_idx').on(t.organizationId, t.accountId)],
);

export const bankFeedItems = pgTable(
  'bank_feed_items',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    batchId: uuid('batch_id').references(() => bankImportBatches.id),
    externalId: text('external_id'),
    txnDate: date('txn_date').notNull(),
    description: text('description').notNull().default(''),
    reference: text('reference'),
    /** Signed: positive = money in (bank debit), negative = money out. */
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    fingerprint: text('fingerprint').notNull(),
    state: text('state', {
      enum: [
        'new',
        'suggested',
        'matched',
        'added',
        'excluded',
        'needs_info',
        'possible_duplicate',
      ],
    })
      .notNull()
      .default('new'),
    matchedJournalEntryId: uuid('matched_journal_entry_id').references(() => journalEntries.id),
    createdSourceType: text('created_source_type'),
    createdSourceId: uuid('created_source_id'),
    appliedRuleId: uuid('applied_rule_id'),
    notes: text('notes'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('bank_feed_items_org_account_state_idx').on(t.organizationId, t.accountId, t.state),
    index('bank_feed_items_fingerprint_idx').on(t.organizationId, t.accountId, t.fingerprint),
    uniqueIndex('bank_feed_items_external_uq')
      .on(t.organizationId, t.accountId, t.externalId)
      .where(sql`external_id IS NOT NULL`),
  ],
);

export const bankRules = pgTable(
  'bank_rules',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    priority: integer('priority').notNull().default(100),
    active: boolean('active').notNull().default(true),
    /** { direction, matchType 'all'|'any', conditions: [{field, op, value}] } */
    conditions: jsonb('conditions')
      .$type<{
        direction: 'in' | 'out' | 'any';
        matchType: 'all' | 'any';
        tests: { field: 'description' | 'reference' | 'amount'; op: string; value: string }[];
      }>()
      .notNull(),
    /** { categoryAccountId, payeeName?, memo? } */
    actions: jsonb('actions')
      .$type<{ categoryAccountId: string; payeeName?: string; memo?: string }>()
      .notNull(),
    autoAdd: boolean('auto_add').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('bank_rules_org_idx').on(t.organizationId, t.active, t.priority)],
);

export const bankRuleApplications = pgTable(
  'bank_rule_applications',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => bankRules.id),
    ruleVersion: integer('rule_version').notNull(),
    feedItemId: uuid('feed_item_id')
      .notNull()
      .references(() => bankFeedItems.id),
    mode: text('mode', { enum: ['suggested', 'auto_added'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('bank_rule_applications_org_idx').on(t.organizationId, t.ruleId)],
);

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    statementStartDate: date('statement_start_date').notNull(),
    statementEndDate: date('statement_end_date').notNull(),
    beginningBalance: numeric('beginning_balance', { precision: 20, scale: 4 }).notNull(),
    endingBalance: numeric('ending_balance', { precision: 20, scale: 4 }).notNull(),
    status: text('status', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    previousReconciliationId: uuid('previous_reconciliation_id'),
    completedByUserId: uuid('completed_by_user_id').references(() => users.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Immutable completion snapshot: cleared lines, totals, difference. */
    snapshot: jsonb('snapshot'),
    hasDiscrepancy: boolean('has_discrepancy').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('reconciliations_org_account_idx').on(t.organizationId, t.accountId),
    uniqueIndex('reconciliations_one_in_progress_uq')
      .on(t.organizationId, t.accountId)
      .where(sql`status = 'in_progress'`),
  ],
);

export const reconciliationItems = pgTable(
  'reconciliation_items',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id, { onDelete: 'cascade' }),
    journalLineId: uuid('journal_line_id')
      .notNull()
      .references(() => journalLines.id),
    createdAt: createdAt(),
  },
  (t) => [
    // A journal line can belong to at most one reconciliation (in progress or
    // completed); abandoning an in-progress reconciliation deletes its items.
    uniqueIndex('reconciliation_items_line_uq').on(t.journalLineId),
    index('reconciliation_items_recon_idx').on(t.reconciliationId),
  ],
);

export const reconciliationDiscrepancies = pgTable(
  'reconciliation_discrepancies',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => reconciliations.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('recon_discrepancies_org_idx').on(t.organizationId, t.reconciliationId)],
);
