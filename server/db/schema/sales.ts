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
import { accounts, journalEntries } from './ledger';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

const POSTING_STATUS = ['draft', 'posted', 'voided', 'reversed'] as const;

export const customers = pgTable(
  'customers',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    displayName: text('display_name').notNull(),
    companyName: text('company_name'),
    contactName: text('contact_name'),
    email: text('email'),
    phone: text('phone'),
    billingAddress: jsonb('billing_address').$type<Record<string, string>>(),
    shippingAddress: jsonb('shipping_address').$type<Record<string, string>>(),
    termsDays: integer('terms_days'),
    taxExempt: boolean('tax_exempt').notNull().default(false),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_org_name_uq').on(t.organizationId, sql`lower(${t.displayName})`),
    index('customers_org_active_idx').on(t.organizationId, t.active),
  ],
);

export const productsServices = pgTable(
  'products_services',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    type: text('type', { enum: ['service', 'non_inventory', 'inventory'] }).notNull(),
    name: text('name').notNull(),
    sku: text('sku'),
    salesDescription: text('sales_description'),
    purchaseDescription: text('purchase_description'),
    salesPrice: numeric('sales_price', { precision: 20, scale: 6 }),
    purchaseCost: numeric('purchase_cost', { precision: 20, scale: 6 }),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id),
    taxable: boolean('taxable').notNull().default(false),
    unitLabel: text('unit_label'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('products_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const taxRates = pgTable(
  'tax_rates',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    agencyName: text('agency_name').notNull().default(''),
    /** Fraction, e.g. 0.0825 for 8.25%. */
    rate: numeric('rate', { precision: 12, scale: 8 }).notNull(),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('tax_rates_org_name_uq').on(t.organizationId, sql`lower(${t.name})`)],
);

export const estimates = pgTable(
  'estimates',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    status: text('status', {
      enum: [
        'draft',
        'sent',
        'accepted',
        'rejected',
        'expired',
        'partially_converted',
        'converted',
        'closed',
      ],
    })
      .notNull()
      .default('draft'),
    estimateDate: date('estimate_date').notNull(),
    expirationDate: date('expiration_date'),
    memo: text('memo'),
    customerMessage: text('customer_message'),
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByName: text('accepted_by_name'),
    acceptedSource: text('accepted_source'),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('estimates_org_number_uq').on(t.organizationId, t.number),
    index('estimates_org_customer_idx').on(t.organizationId, t.customerId),
  ],
);

export const estimateLines = pgTable(
  'estimate_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    estimateId: uuid('estimate_id')
      .notNull()
      .references(() => estimates.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }).notNull().default('0'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    taxable: boolean('taxable').notNull().default(false),
    convertedQuantity: numeric('converted_quantity', { precision: 20, scale: 6 })
      .notNull()
      .default('0'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('estimate_lines_estimate_line_uq').on(t.estimateId, t.lineNumber)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    estimateId: uuid('estimate_id').references(() => estimates.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    invoiceDate: date('invoice_date').notNull(),
    dueDate: date('due_date').notNull(),
    termsDays: integer('terms_days'),
    memo: text('memo'),
    customerMessage: text('customer_message'),
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
    /** Exact tax snapshot frozen at posting. */
    taxSnapshot: jsonb('tax_snapshot').$type<{ rate: string; name: string } | null>(),
    /** Full frozen document data + template version, written at posting. */
    frozenDocument: jsonb('frozen_document'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    correctionOfInvoiceId: uuid('correction_of_invoice_id'),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invoices_org_number_uq').on(t.organizationId, t.number),
    index('invoices_org_customer_idx').on(t.organizationId, t.customerId),
    index('invoices_org_status_due_idx').on(t.organizationId, t.postingStatus, t.dueDate),
  ],
);

export const invoiceLines = pgTable(
  'invoice_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }).notNull().default('0'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    taxable: boolean('taxable').notNull().default(false),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id),
    estimateLineId: uuid('estimate_line_id').references(() => estimateLines.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('invoice_lines_invoice_line_uq').on(t.invoiceId, t.lineNumber)],
);

export const customerPayments = pgTable(
  'customer_payments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    paymentDate: date('payment_date').notNull(),
    method: text('method'),
    reference: text('reference'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    depositToAccountId: uuid('deposit_to_account_id')
      .notNull()
      .references(() => accounts.id),
    memo: text('memo'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customer_payments_org_number_uq').on(t.organizationId, t.number),
    index('customer_payments_org_customer_idx').on(t.organizationId, t.customerId),
  ],
);

/**
 * Append-only allocation history. Unapply = a new row referencing
 * reversal_of_allocation_id with negated amount; rows are never edited.
 */
export const customerPaymentAllocations = pgTable(
  'customer_payment_allocations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => customerPayments.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    reversalOfAllocationId: uuid('reversal_of_allocation_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('cpa_org_invoice_idx').on(t.organizationId, t.invoiceId, t.effectiveDate),
    index('cpa_org_payment_idx').on(t.organizationId, t.paymentId),
  ],
);

export const creditMemos = pgTable(
  'credit_memos',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    creditDate: date('credit_date').notNull(),
    memo: text('memo'),
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('credit_memos_org_number_uq').on(t.organizationId, t.number)],
);

export const creditMemoLines = pgTable(
  'credit_memo_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    creditMemoId: uuid('credit_memo_id')
      .notNull()
      .references(() => creditMemos.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }).notNull().default('0'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    taxable: boolean('taxable').notNull().default(false),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('credit_memo_lines_line_uq').on(t.creditMemoId, t.lineNumber)],
);

export const creditAllocations = pgTable(
  'credit_allocations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    creditMemoId: uuid('credit_memo_id')
      .notNull()
      .references(() => creditMemos.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    reversalOfAllocationId: uuid('reversal_of_allocation_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('ca_org_invoice_idx').on(t.organizationId, t.invoiceId, t.effectiveDate)],
);

export const invoiceWriteOffs = pgTable(
  'invoice_write_offs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoices.id),
    writeOffDate: date('write_off_date').notNull(),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    expenseAccountId: uuid('expense_account_id')
      .notNull()
      .references(() => accounts.id),
    reason: text('reason').notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    reversalOfWriteOffId: uuid('reversal_of_write_off_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('write_offs_org_invoice_idx').on(t.organizationId, t.invoiceId)],
);

export const salesReceipts = pgTable(
  'sales_receipts',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    receiptDate: date('receipt_date').notNull(),
    depositToAccountId: uuid('deposit_to_account_id')
      .notNull()
      .references(() => accounts.id),
    memo: text('memo'),
    subtotal: numeric('subtotal', { precision: 20, scale: 4 }).notNull().default('0'),
    taxTotal: numeric('tax_total', { precision: 20, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    taxRateId: uuid('tax_rate_id').references(() => taxRates.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('sales_receipts_org_number_uq').on(t.organizationId, t.number)],
);

export const salesReceiptLines = pgTable(
  'sales_receipt_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    salesReceiptId: uuid('sales_receipt_id')
      .notNull()
      .references(() => salesReceipts.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull().default('1'),
    unitPrice: numeric('unit_price', { precision: 20, scale: 6 }).notNull().default('0'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    taxable: boolean('taxable').notNull().default(false),
    incomeAccountId: uuid('income_account_id').references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sales_receipt_lines_line_uq').on(t.salesReceiptId, t.lineNumber)],
);

export const deposits = pgTable(
  'deposits',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    depositDate: date('deposit_date').notNull(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => accounts.id),
    memo: text('memo'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('deposits_org_number_uq').on(t.organizationId, t.number)],
);

export const depositComponents = pgTable(
  'deposit_components',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    sourceType: text('source_type', {
      enum: ['customer_payment', 'sales_receipt', 'other'],
    }).notNull(),
    /** customer_payment / sales_receipt id when sourceType references one. */
    sourceId: uuid('source_id'),
    /** For `other` lines: the credited account (interest income, owner equity, ...). */
    accountId: uuid('account_id').references(() => accounts.id),
    description: text('description'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('deposit_components_line_uq').on(t.depositId, t.lineNumber),
    index('deposit_components_source_idx').on(t.organizationId, t.sourceType, t.sourceId),
  ],
);
