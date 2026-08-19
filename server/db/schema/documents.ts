import {
  bigint,
  index,
  integer,
  jsonb,
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

export const attachments = pgTable(
  'attachments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** Random server-generated object key; never derived from user filenames. */
    storageKey: text('storage_key').notNull(),
    originalFilename: text('original_filename').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256').notNull(),
    scanState: text('scan_state', {
      enum: ['pending_scan', 'clean', 'rejected', 'unscanned_download_only'],
    })
      .notNull()
      .default('unscanned_download_only'),
    kind: text('kind', { enum: ['brand_asset', 'receipt', 'document', 'statement', 'other'] })
      .notNull()
      .default('other'),
    uploadedByUserId: uuid('uploaded_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('attachments_storage_key_uq').on(t.storageKey),
    index('attachments_org_idx').on(t.organizationId, t.createdAt),
  ],
);

export const entityAttachments = pgTable(
  'entity_attachments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('entity_attachments_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    uniqueIndex('entity_attachments_uq').on(t.attachmentId, t.entityType, t.entityId),
  ],
);

export const importJobs = pgTable(
  'import_jobs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    kind: text('kind', {
      enum: ['customers', 'vendors', 'products', 'accounts', 'bank_transactions'],
    }).notNull(),
    filename: text('filename').notNull(),
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
    status: text('status', { enum: ['dry_run', 'completed', 'failed'] })
      .notNull()
      .default('dry_run'),
    rowCount: integer('row_count').notNull().default(0),
    createdCount: integer('created_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    errors: jsonb('errors').$type<{ row: number; message: string }[]>().notNull().default([]),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('import_jobs_org_idx').on(t.organizationId, t.createdAt)],
);
