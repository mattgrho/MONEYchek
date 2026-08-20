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
import { customers, productsServices } from './sales';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

const POSTING_STATUS = ['draft', 'posted', 'voided', 'reversed'] as const;

export const vendors = pgTable(
  'vendors',
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
    remittanceAddress: jsonb('remittance_address').$type<Record<string, string>>(),
    termsDays: integer('terms_days'),
    is1099Eligible: boolean('is_1099_eligible').notNull().default(false),
    taxIdLastFour: text('tax_id_last_four'),
    defaultExpenseAccountId: uuid('default_expense_account_id').references(() => accounts.id),
    notes: text('notes'),
    active: boolean('active').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('vendors_org_name_uq').on(t.organizationId, sql`lower(${t.displayName})`),
    index('vendors_org_active_idx').on(t.organizationId, t.active),
  ],
);

export const bills = pgTable(
  'bills',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    vendorReference: text('vendor_reference'),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    approvalStatus: text('approval_status', {
      enum: ['not_required', 'pending', 'partially_approved', 'approved', 'rejected'],
    })
      .notNull()
      .default('not_required'),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrders.id),
    billDate: date('bill_date').notNull(),
    dueDate: date('due_date').notNull(),
    termsDays: integer('terms_days'),
    memo: text('memo'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    submittedByUserId: uuid('submitted_by_user_id').references(() => users.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedByUserId: uuid('rejected_by_user_id').references(() => users.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('bills_org_number_uq').on(t.organizationId, t.number),
    index('bills_org_vendor_idx').on(t.organizationId, t.vendorId),
    index('bills_org_status_due_idx').on(t.organizationId, t.postingStatus, t.dueDate),
  ],
);

export const billLines = pgTable(
  'bill_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id').references(() => accounts.id),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }),
    unitCost: numeric('unit_cost', { precision: 20, scale: 6 }),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    billableCustomerId: uuid('billable_customer_id').references(() => customers.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('bill_lines_bill_line_uq').on(t.billId, t.lineNumber)],
);

export const vendorCredits = pgTable(
  'vendor_credits',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    creditDate: date('credit_date').notNull(),
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
  (t) => [uniqueIndex('vendor_credits_org_number_uq').on(t.organizationId, t.number)],
);

export const vendorCreditLines = pgTable(
  'vendor_credit_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    vendorCreditId: uuid('vendor_credit_id')
      .notNull()
      .references(() => vendorCredits.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id').references(() => accounts.id),
    productId: uuid('product_id').references(() => productsServices.id),
    description: text('description').notNull().default(''),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('vendor_credit_lines_line_uq').on(t.vendorCreditId, t.lineNumber)],
);

export const vendorCreditAllocations = pgTable(
  'vendor_credit_allocations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    vendorCreditId: uuid('vendor_credit_id')
      .notNull()
      .references(() => vendorCredits.id),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    reversalOfAllocationId: uuid('reversal_of_allocation_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('vca_org_bill_idx').on(t.organizationId, t.billId, t.effectiveDate),
    index('vca_bill_idx').on(t.billId),
    index('vca_credit_idx').on(t.vendorCreditId),
  ],
);

export const billPayments = pgTable(
  'bill_payments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    paymentDate: date('payment_date').notNull(),
    bankAccountId: uuid('bank_account_id')
      .notNull()
      .references(() => accounts.id),
    method: text('method'),
    reference: text('reference'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
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
    uniqueIndex('bill_payments_org_number_uq').on(t.organizationId, t.number),
    index('bill_payments_org_vendor_idx').on(t.organizationId, t.vendorId),
  ],
);

export const billPaymentAllocations = pgTable(
  'bill_payment_allocations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    billPaymentId: uuid('bill_payment_id')
      .notNull()
      .references(() => billPayments.id),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull(),
    effectiveDate: date('effective_date').notNull(),
    reversalOfAllocationId: uuid('reversal_of_allocation_id'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index('bpa_org_bill_idx').on(t.organizationId, t.billId, t.effectiveDate),
    index('bpa_bill_idx').on(t.billId),
    index('bpa_payment_idx').on(t.billPaymentId),
  ],
);

export const expenses = pgTable(
  'expenses',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id),
    payeeName: text('payee_name'),
    postingStatus: text('posting_status', { enum: POSTING_STATUS }).notNull().default('draft'),
    expenseDate: date('expense_date').notNull(),
    paymentAccountId: uuid('payment_account_id')
      .notNull()
      .references(() => accounts.id),
    method: text('method', { enum: ['check', 'card', 'cash', 'ach', 'other'] })
      .notNull()
      .default('other'),
    reference: text('reference'),
    memo: text('memo'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedByUserId: uuid('posted_by_user_id').references(() => users.id),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedByUserId: uuid('voided_by_user_id').references(() => users.id),
    voidReason: text('void_reason'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('expenses_org_number_uq').on(t.organizationId, t.number),
    index('expenses_org_date_idx').on(t.organizationId, t.expenseDate),
  ],
);

export const expenseLines = pgTable(
  'expense_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    expenseId: uuid('expense_id')
      .notNull()
      .references(() => expenses.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    description: text('description').notNull().default(''),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    billableCustomerId: uuid('billable_customer_id').references(() => customers.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('expense_lines_expense_line_uq').on(t.expenseId, t.lineNumber)],
);

/**
 * Purchase orders are commitments, not accounting events: nothing posts to
 * the ledger until a PO converts into a bill. Conversion tracks billed
 * quantity per line so partial billing is exact and overbilling is blocked.
 */
export const purchaseOrders = pgTable(
  'purchase_orders',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    number: text('number').notNull(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id),
    status: text('status', {
      enum: ['draft', 'open', 'partially_billed', 'billed', 'closed', 'canceled'],
    })
      .notNull()
      .default('draft'),
    poDate: date('po_date').notNull(),
    expectedDate: date('expected_date'),
    shipTo: text('ship_to'),
    memo: text('memo'),
    vendorMessage: text('vendor_message'),
    total: numeric('total', { precision: 20, scale: 4 }).notNull().default('0'),
    version: integer('version').notNull().default(1),
    createdByUserId: uuid('created_by_user_id').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('purchase_orders_org_number_uq').on(t.organizationId, t.number),
    index('purchase_orders_org_vendor_idx').on(t.organizationId, t.vendorId),
    index('purchase_orders_org_status_idx').on(t.organizationId, t.status),
  ],
);

export const purchaseOrderLines = pgTable(
  'purchase_order_lines',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrders.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    productId: uuid('product_id').references(() => productsServices.id),
    accountId: uuid('account_id').references(() => accounts.id),
    description: text('description').notNull().default(''),
    quantity: numeric('quantity', { precision: 20, scale: 6 }).notNull().default('1'),
    unitCost: numeric('unit_cost', { precision: 20, scale: 6 }).notNull().default('0'),
    amount: numeric('amount', { precision: 20, scale: 4 }).notNull().default('0'),
    billedQuantity: numeric('billed_quantity', { precision: 20, scale: 6 }).notNull().default('0'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('po_lines_po_line_uq').on(t.purchaseOrderId, t.lineNumber)],
);

/**
 * Immutable per-step approval decisions. Two-step mode requires two distinct
 * approvers, both different from the submitter (separation of duties).
 */
export const billApprovals = pgTable(
  'bill_approvals',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    billId: uuid('bill_id')
      .notNull()
      .references(() => bills.id),
    step: integer('step').notNull(),
    decision: text('decision', { enum: ['approved', 'rejected'] }).notNull(),
    decidedByUserId: uuid('decided_by_user_id')
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason'),
  },
  (t) => [index('bill_approvals_bill_idx').on(t.billId)],
);
