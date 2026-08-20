/**
 * Permission model: `${resource}.${action}` keys enforced on the server for
 * every route and object access. Hiding a button is never authorization.
 *
 * Role presets are seeded per organization and may be customized; the key
 * strings below are canonical and stable (terminology aliases never rename
 * them).
 */

export const RESOURCES = [
  'company',
  'brand',
  'users',
  'roles',
  'customers',
  'vendors',
  'products',
  'estimates',
  'invoices',
  'sales_receipts',
  'customer_payments',
  'credit_memos',
  'deposits',
  'bills',
  'bill_payments',
  'expenses',
  'vendor_credits',
  'purchase_orders',
  'retainers',
  'banking',
  'reconciliations',
  'accounts',
  'journals',
  'periods',
  'reports',
  'attachments',
  'imports',
  'exports',
  'audit',
] as const;

export type Resource = (typeof RESOURCES)[number];

export const ACTIONS = [
  'view',
  'create',
  'edit',
  'post',
  'approve',
  'pay',
  'reconcile',
  'void',
  'reverse',
  'export',
  'administer',
  'invite',
  'close',
  'reopen',
] as const;

export type Action = (typeof ACTIONS)[number];

export type PermissionKey = `${Resource}.${Action}` | '*';

export function permissionKey(resource: Resource, action: Action): PermissionKey {
  return `${resource}.${action}`;
}

export function hasPermission(granted: readonly string[], required: PermissionKey): boolean {
  if (required === '*') return granted.includes('*');
  return granted.includes('*') || granted.includes(required);
}

function keys(resource: Resource, actions: Action[]): PermissionKey[] {
  return actions.map((a) => permissionKey(resource, a));
}

const VIEW_ALL_CORE: PermissionKey[] = [
  ...keys('customers', ['view']),
  ...keys('vendors', ['view']),
  ...keys('products', ['view']),
  ...keys('estimates', ['view']),
  ...keys('invoices', ['view']),
  ...keys('sales_receipts', ['view']),
  ...keys('customer_payments', ['view']),
  ...keys('credit_memos', ['view']),
  ...keys('deposits', ['view']),
  ...keys('bills', ['view']),
  ...keys('bill_payments', ['view']),
  ...keys('expenses', ['view']),
  ...keys('vendor_credits', ['view']),
  ...keys('purchase_orders', ['view']),
  ...keys('retainers', ['view']),
  ...keys('banking', ['view']),
  ...keys('reconciliations', ['view']),
  ...keys('accounts', ['view']),
  ...keys('journals', ['view']),
  ...keys('periods', ['view']),
  ...keys('reports', ['view']),
  ...keys('attachments', ['view']),
];

const AR_FULL: PermissionKey[] = [
  ...keys('customers', ['view', 'create', 'edit']),
  ...keys('products', ['view', 'create', 'edit']),
  ...keys('estimates', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('invoices', ['view', 'create', 'edit', 'post', 'void', 'reverse']),
  ...keys('sales_receipts', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('customer_payments', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('credit_memos', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('deposits', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('retainers', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('reports', ['view']),
  ...keys('attachments', ['view', 'create']),
];

const AP_FULL: PermissionKey[] = [
  ...keys('vendors', ['view', 'create', 'edit']),
  ...keys('products', ['view']),
  ...keys('bills', ['view', 'create', 'edit', 'post', 'approve', 'void', 'reverse']),
  ...keys('bill_payments', ['view', 'create', 'edit', 'post', 'pay', 'void']),
  ...keys('expenses', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('vendor_credits', ['view', 'create', 'edit', 'post', 'void']),
  ...keys('purchase_orders', ['view', 'create', 'edit', 'void']),
  ...keys('reports', ['view']),
  ...keys('attachments', ['view', 'create']),
];

const ACCOUNTANT: PermissionKey[] = [
  ...VIEW_ALL_CORE,
  ...AR_FULL,
  ...AP_FULL,
  ...keys('banking', ['view', 'create', 'edit', 'post']),
  ...keys('reconciliations', ['view', 'create', 'edit', 'reconcile']),
  ...keys('accounts', ['view', 'create', 'edit']),
  ...keys('journals', ['view', 'create', 'edit', 'post', 'reverse']),
  ...keys('periods', ['view', 'close', 'reopen']),
  ...keys('reports', ['view', 'export']),
  ...keys('imports', ['view', 'create']),
  ...keys('audit', ['view']),
];

/** Preset role definitions seeded for every organization. */
export const ROLE_PRESETS: Record<
  string,
  { name: string; description: string; permissions: PermissionKey[] }
> = {
  owner: {
    name: 'Owner',
    description: 'Full authority over configuration and controlled corrections.',
    permissions: ['*'],
  },
  company_admin: {
    name: 'Company Administrator',
    description: 'Company settings, brand, users, and roles; full bookkeeping access.',
    permissions: ['*'],
  },
  finance_admin: {
    name: 'Finance Administrator',
    description: 'All financial workflows and financial settings; no user administration.',
    permissions: [
      ...ACCOUNTANT,
      ...keys('company', ['view', 'edit']),
      ...keys('exports', ['view', 'create']),
    ],
  },
  accountant: {
    name: 'Accountant',
    description: 'Journals, close, reconciliation, and every core financial workflow.',
    permissions: ACCOUNTANT,
  },
  bookkeeper: {
    name: 'Bookkeeper',
    description: 'Day-to-day AR/AP/banking entry without period close or user admin.',
    permissions: [
      ...AR_FULL,
      ...AP_FULL,
      ...keys('banking', ['view', 'create', 'edit', 'post']),
      ...keys('reconciliations', ['view', 'create', 'edit', 'reconcile']),
      ...keys('accounts', ['view']),
      ...keys('journals', ['view']),
      ...keys('imports', ['view', 'create']),
    ],
  },
  ar_manager: {
    name: 'Accounts Receivable Manager',
    description: 'Customers, estimates, invoices, payments, credits, and deposits.',
    permissions: AR_FULL,
  },
  ap_manager: {
    name: 'Accounts Payable Manager',
    description: 'Vendors, bills, approvals, payments, credits, and expenses.',
    permissions: AP_FULL,
  },
  bill_clerk: {
    name: 'Bill Clerk',
    description: 'Enters draft bills and expenses; cannot approve, post, or pay.',
    permissions: [
      ...keys('vendors', ['view', 'create']),
      ...keys('bills', ['view', 'create', 'edit']),
      ...keys('expenses', ['view', 'create', 'edit']),
      ...keys('purchase_orders', ['view', 'create', 'edit']),
      ...keys('attachments', ['view', 'create']),
    ],
  },
  bill_approver: {
    name: 'Bill Approver',
    description: 'Approves or rejects submitted bills; cannot pay them.',
    permissions: [
      ...keys('vendors', ['view']),
      ...keys('bills', ['view', 'approve', 'post']),
      ...keys('attachments', ['view']),
    ],
  },
  bill_payer: {
    name: 'Bill Payer',
    description: 'Pays approved bills; cannot create or approve them.',
    permissions: [
      ...keys('vendors', ['view']),
      ...keys('bills', ['view']),
      ...keys('bill_payments', ['view', 'create', 'edit', 'post', 'pay']),
      ...keys('attachments', ['view']),
    ],
  },
  sales_manager: {
    name: 'Sales Manager',
    description: 'Customers, estimates, and invoicing without banking access.',
    permissions: [
      ...keys('customers', ['view', 'create', 'edit']),
      ...keys('products', ['view', 'create', 'edit']),
      ...keys('estimates', ['view', 'create', 'edit', 'post', 'void']),
      ...keys('invoices', ['view', 'create', 'edit', 'post']),
      ...keys('reports', ['view']),
      ...keys('attachments', ['view', 'create']),
    ],
  },
  expense_submitter: {
    name: 'Expense Submitter',
    description: 'Creates draft expenses with receipts; sees only their own entries.',
    permissions: [
      ...keys('expenses', ['view', 'create', 'edit']),
      ...keys('attachments', ['view', 'create']),
    ],
  },
  reports_viewer: {
    name: 'Reports Viewer',
    description: 'Read-only financial reports.',
    permissions: [...keys('reports', ['view'])],
  },
  auditor: {
    name: 'Auditor',
    description: 'Read-only access to everything including the audit log.',
    permissions: [
      ...VIEW_ALL_CORE,
      ...keys('audit', ['view']),
      ...keys('reports', ['view', 'export']),
    ],
  },
};

export type RolePresetKey = keyof typeof ROLE_PRESETS;
