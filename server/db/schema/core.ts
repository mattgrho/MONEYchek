import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Shared column helpers */
const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended'] })
    .notNull()
    .default('active'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Single-company deployment binding. Exactly one row (id=1). Written only by
 * the atomic bootstrap transaction; the primary organization is resolved from
 * here on the server, never from client input.
 */
export const deploymentSettings = pgTable('deployment_settings', {
  id: smallint('id').primaryKey().default(1),
  primaryOrganizationId: uuid('primary_organization_id').references(() => organizations.id),
  bootstrapCompletedAt: timestamp('bootstrap_completed_at', { withTimezone: true }),
  bootstrapOwnerEmail: text('bootstrap_owner_email'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable(
  'users',
  {
    id: id(),
    authProviderId: text('auth_provider_id').notNull(),
    email: text('email').notNull(),
    name: text('name'),
    imageUrl: text('image_url'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('users_auth_provider_id_uq').on(t.authProviderId)],
);

export const roles = pgTable(
  'roles',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    permissions: jsonb('permissions').$type<string[]>().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_org_key_uq').on(t.organizationId, t.key)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    status: text('status', { enum: ['active', 'removed'] })
      .notNull()
      .default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('memberships_org_user_uq').on(t.organizationId, t.userId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    email: text('email').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id),
    tokenHash: text('token_hash').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('invitations_token_hash_uq').on(t.tokenHash),
    index('invitations_org_email_idx').on(t.organizationId, t.email),
  ],
);

export const companyProfiles = pgTable(
  'company_profiles',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    legalName: text('legal_name').notNull().default(''),
    displayName: text('display_name').notNull().default(''),
    shortName: text('short_name'),
    applicationName: text('application_name'),
    entityType: text('entity_type'),
    industry: text('industry'),
    addresses: jsonb('addresses')
      .$type<
        Record<
          string,
          {
            line1?: string;
            line2?: string;
            city?: string;
            region?: string;
            postalCode?: string;
            country?: string;
          }
        >
      >()
      .notNull()
      .default({}),
    phone: text('phone'),
    supportEmail: text('support_email'),
    billingEmail: text('billing_email'),
    website: text('website'),
    timeZone: text('time_zone').notNull().default('America/New_York'),
    locale: text('locale').notNull().default('en-US'),
    homeCurrency: text('home_currency').notNull().default('USD'),
    dateFormat: text('date_format').notNull().default('MM/dd/yyyy'),
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),
    bookkeepingStartDate: date('bookkeeping_start_date'),
    reportBasis: text('report_basis', { enum: ['accrual'] })
      .notNull()
      .default('accrual'),
    legalFooter: text('legal_footer'),
    paymentInstructions: text('payment_instructions'),
    documentDisclaimer: text('document_disclaimer'),
    terminology: jsonb('terminology')
      .$type<Record<string, { singular: string; plural: string }>>()
      .notNull()
      .default({}),
    onboardingStep: text('onboarding_step').notNull().default('company'),
    onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('company_profiles_org_uq').on(t.organizationId)],
);

export const brandSettings = pgTable(
  'brand_settings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    /** Application theme tokens (light + dark) as CSS-variable-ready values. */
    tokens: jsonb('tokens').$type<Record<string, string>>().notNull().default({}),
    themeMode: text('theme_mode', { enum: ['light', 'dark', 'system'] })
      .notNull()
      .default('system'),
    fontFamily: text('font_family').notNull().default('system'),
    radius: text('radius').notNull().default('0.5rem'),
    density: text('density', { enum: ['comfortable', 'compact'] })
      .notNull()
      .default('comfortable'),
    primaryLogoAttachmentId: uuid('primary_logo_attachment_id'),
    compactLogoAttachmentId: uuid('compact_logo_attachment_id'),
    faviconAttachmentId: uuid('favicon_attachment_id'),
    /** External document (PDF) theme, separate from the app theme. */
    documentTheme: jsonb('document_theme').$type<Record<string, string>>().notNull().default({}),
    /** Financial presentation settings (report titles, negative format, ...). */
    financialPresentation: jsonb('financial_presentation')
      .$type<Record<string, string | boolean>>()
      .notNull()
      .default({}),
    brandVersion: integer('brand_version').notNull().default(1),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('brand_settings_org_uq').on(t.organizationId)],
);

export const accountingSettings = pgTable(
  'accounting_settings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountNumbersEnabled: boolean('account_numbers_enabled').notNull().default(true),
    arAccountId: uuid('ar_account_id'),
    apAccountId: uuid('ap_account_id'),
    undepositedFundsAccountId: uuid('undeposited_funds_account_id'),
    openingBalanceEquityAccountId: uuid('opening_balance_equity_account_id'),
    retainedEarningsAccountId: uuid('retained_earnings_account_id'),
    salesTaxPayableAccountId: uuid('sales_tax_payable_account_id'),
    inventoryAssetAccountId: uuid('inventory_asset_account_id'),
    inventoryAdjustmentAccountId: uuid('inventory_adjustment_account_id'),
    cogsAccountId: uuid('cogs_account_id'),
    defaultIncomeAccountId: uuid('default_income_account_id'),
    defaultExpenseAccountId: uuid('default_expense_account_id'),
    badDebtAccountId: uuid('bad_debt_account_id'),
    customerRetainersAccountId: uuid('customer_retainers_account_id'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('accounting_settings_org_uq').on(t.organizationId)],
);

export const salesSettings = pgTable(
  'sales_settings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    defaultTermsDays: integer('default_terms_days').notNull().default(30),
    customerLabel: text('customer_label').notNull().default('Customer'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sales_settings_org_uq').on(t.organizationId)],
);

export const purchasingSettings = pgTable(
  'purchasing_settings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    billApprovalThreshold: numeric('bill_approval_threshold', { precision: 20, scale: 4 }),
    /** one_step: a single approver; two_step: two distinct approvers. */
    approvalMode: text('approval_mode', { enum: ['one_step', 'two_step'] })
      .notNull()
      .default('one_step'),
    separationOfDuties: boolean('separation_of_duties').notNull().default(true),
    vendorLabel: text('vendor_label').notNull().default('Vendor'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('purchasing_settings_org_uq').on(t.organizationId)],
);

export const featureFlags = pgTable(
  'feature_flags',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    key: text('key').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('feature_flags_org_key_uq').on(t.organizationId, t.key)],
);

export const numberSequences = pgTable(
  'number_sequences',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    documentType: text('document_type').notNull(),
    prefix: text('prefix').notNull().default(''),
    nextValue: bigint('next_value', { mode: 'number' }).notNull().default(1),
    padding: integer('padding').notNull().default(4),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('number_sequences_org_type_uq').on(t.organizationId, t.documentType)],
);

/**
 * Idempotency records for every financial command. Reuse with the same
 * canonical payload returns the stored result; a different payload returns
 * 409 IDEMPOTENCY_CONFLICT. Retained for the life of the accounting record.
 */
export const postingCommands = pgTable(
  'posting_commands',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    idempotencyKey: text('idempotency_key').notNull(),
    commandType: text('command_type').notNull(),
    requestHash: text('request_hash').notNull(),
    state: text('state', { enum: ['processing', 'completed', 'failed'] })
      .notNull()
      .default('processing'),
    result: jsonb('result'),
    actorUserId: uuid('actor_user_id'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('posting_commands_org_key_uq').on(t.organizationId, t.idempotencyKey)],
);

/**
 * Immutable audit chain. Organization-scoped monotonic sequence with a hash
 * chain over canonical payloads (tamper-evidence indicator, not proof against
 * a database administrator).
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    actorUserId: uuid('actor_user_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    reason: text('reason'),
    payload: jsonb('payload').notNull().default({}),
    correlationId: text('correlation_id'),
    prevHash: text('prev_hash').notNull(),
    hash: text('hash').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('audit_events_org_seq_uq').on(t.organizationId, t.seq),
    index('audit_events_org_entity_idx').on(t.organizationId, t.entityType, t.entityId),
    index('audit_events_org_created_idx').on(t.organizationId, t.createdAt),
  ],
);

/** Transactional outbox for external side effects (email, exports, jobs). */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    idempotencyKey: text('idempotency_key'),
    state: text('state', { enum: ['pending', 'processing', 'completed', 'failed', 'dead'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(8),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('outbox_events_claim_idx').on(t.state, t.scheduledAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_org_user_idx').on(t.organizationId, t.userId, t.readAt)],
);
