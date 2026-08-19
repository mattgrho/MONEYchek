import {
  bigint,
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

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const ACCOUNT_CATEGORIES = [
  'asset',
  'contra_asset',
  'liability',
  'equity',
  'contra_equity',
  'income',
  'contra_income',
  'cogs',
  'expense',
  'other_income',
  'other_expense',
] as const;
export type AccountCategory = (typeof ACCOUNT_CATEGORIES)[number];

export const accounts = pgTable(
  'accounts',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number'),
    name: text('name').notNull(),
    parentAccountId: uuid('parent_account_id'),
    category: text('category', { enum: ACCOUNT_CATEGORIES }).notNull(),
    detailType: text('detail_type').notNull(),
    normalBalance: text('normal_balance', { enum: ['debit', 'credit'] }).notNull(),
    description: text('description'),
    /** Protected accounts (AR, AP, Undeposited Funds, ...) carry a stable key. */
    systemKey: text('system_key'),
    postable: boolean('postable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('accounts_org_system_key_uq').on(t.organizationId, t.systemKey),
    uniqueIndex('accounts_org_name_uq').on(t.organizationId, sql`lower(${t.name})`),
    index('accounts_org_category_idx').on(t.organizationId, t.category),
    index('accounts_org_parent_idx').on(t.organizationId, t.parentAccountId),
  ],
);

export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status', { enum: ['open', 'soft_closed', 'hard_closed'] })
      .notNull()
      .default('open'),
    closedByUserId: uuid('closed_by_user_id').references(() => users.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    reopenedByUserId: uuid('reopened_by_user_id').references(() => users.id),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenReason: text('reopen_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('fiscal_periods_org_start_uq').on(t.organizationId, t.startDate),
    index('fiscal_periods_org_range_idx').on(t.organizationId, t.startDate, t.endDate),
  ],
);

/**
 * The journal. Posted entries are append-only: database triggers reject
 * updates to financial fields and any delete. Corrections happen through
 * linked reversal entries created by the posting engine.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    entryNumber: bigint('entry_number', { mode: 'number' }).notNull(),
    status: text('status', { enum: ['posted'] })
      .notNull()
      .default('posted'),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id'),
    postingDate: date('posting_date').notNull(),
    memo: text('memo'),
    /** Set when this entry reverses another entry. */
    reversalOfEntryId: uuid('reversal_of_entry_id'),
    /** Set (by trigger-allowed update) when a later entry reverses this one. */
    reversedByEntryId: uuid('reversed_by_entry_id'),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    correlationId: text('correlation_id'),
    /** sha256 over canonical line data; used by ledger rebuild verification. */
    linesHash: text('lines_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_entries_org_number_uq').on(t.organizationId, t.entryNumber),
    index('journal_entries_org_date_idx').on(t.organizationId, t.postingDate),
    index('journal_entries_org_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
  ],
);

export const journalLines = pgTable(
  'journal_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    debit: numeric('debit', { precision: 20, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 20, scale: 4 }).notNull().default('0'),
    partyType: text('party_type', { enum: ['customer', 'vendor'] }),
    partyId: uuid('party_id'),
    productId: uuid('product_id'),
    projectId: uuid('project_id'),
    classId: uuid('class_id'),
    locationId: uuid('location_id'),
    memo: text('memo'),
    /**
     * Banking register status. `cleared` is presentation/reconciliation state,
     * not a financial amount; it is the only mutable flag on a posted line and
     * flips inside reconciliation/matching workflows only.
     */
    cleared: boolean('cleared').notNull().default(false),
    reconciliationId: uuid('reconciliation_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('journal_lines_entry_line_uq').on(t.entryId, t.lineNumber),
    index('journal_lines_org_account_idx').on(t.organizationId, t.accountId),
    index('journal_lines_org_party_idx').on(t.organizationId, t.partyType, t.partyId),
    index('journal_lines_entry_idx').on(t.entryId),
  ],
);

export const journalLinks = pgTable(
  'journal_links',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    fromEntryId: uuid('from_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    toEntryId: uuid('to_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    kind: text('kind', { enum: ['reversal', 'correction', 'void', 'refund', 'nsf'] }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('journal_links_org_from_idx').on(t.organizationId, t.fromEntryId)],
);

/**
 * Draft manual journal entries live outside the immutable journal until they
 * post. Posting writes real journal_entries/journal_lines via the engine.
 */
export const manualJournals = pgTable(
  'manual_journals',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number'),
    journalDate: date('journal_date').notNull(),
    memo: text('memo'),
    lines: jsonb('lines')
      .$type<
        {
          accountId: string;
          debit: string;
          credit: string;
          memo?: string;
          partyType?: 'customer' | 'vendor';
          partyId?: string;
        }[]
      >()
      .notNull()
      .default([]),
    postingStatus: text('posting_status', { enum: ['draft', 'posted', 'reversed', 'voided'] })
      .notNull()
      .default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('manual_journals_org_idx').on(t.organizationId, t.journalDate)],
);
