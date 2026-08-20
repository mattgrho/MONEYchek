import {
  Banknote,
  BarChart3,
  FileText,
  Landmark,
  ShoppingCart,
  BookOpenCheck,
  LayoutDashboard,
  Receipt,
  Settings,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  to: string;
  /** Server-enforced permission that also gates visibility. */
  permission: string;
}

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

/**
 * Stable top-level groups. Items appear only once their feature is genuinely
 * implemented and the member holds the permission — no dead navigation.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Overview',
    icon: LayoutDashboard,
    items: [{ label: 'Dashboard', to: '/', permission: 'reports.view' }],
  },
  {
    label: 'Sales',
    icon: Receipt,
    items: [
      { label: 'Customers', to: '/sales/customers', permission: 'customers.view' },
      { label: 'Estimates', to: '/sales/estimates', permission: 'estimates.view' },
      { label: 'Invoices', to: '/sales/invoices', permission: 'invoices.view' },
      { label: 'Payments', to: '/sales/payments', permission: 'customer_payments.view' },
      { label: 'Sales receipts', to: '/sales/receipts', permission: 'sales_receipts.view' },
      { label: 'Credit memos', to: '/sales/credits', permission: 'credit_memos.view' },
      { label: 'Deposits', to: '/sales/deposits', permission: 'deposits.view' },
      { label: 'Retainers', to: '/sales/retainers', permission: 'retainers.view' },
      { label: 'Products & services', to: '/sales/products', permission: 'products.view' },
    ],
  },
  {
    label: 'Expenses',
    icon: ShoppingCart,
    items: [
      { label: 'Vendors', to: '/expenses/vendors', permission: 'vendors.view' },
      {
        label: 'Purchase orders',
        to: '/expenses/purchase-orders',
        permission: 'purchase_orders.view',
      },
      { label: 'Bills', to: '/expenses/bills', permission: 'bills.view' },
      { label: 'Expenses', to: '/expenses/expenses', permission: 'expenses.view' },
      { label: 'Bill payments', to: '/expenses/bill-payments', permission: 'bill_payments.view' },
      {
        label: 'Vendor credits',
        to: '/expenses/vendor-credits',
        permission: 'vendor_credits.view',
      },
    ],
  },
  {
    label: 'Banking',
    icon: Landmark,
    items: [
      { label: 'Bank transactions', to: '/banking/review', permission: 'banking.view' },
      { label: 'Registers', to: '/banking/registers', permission: 'banking.view' },
      { label: 'Rules', to: '/banking/rules', permission: 'banking.view' },
      { label: 'Reconcile', to: '/banking/reconcile', permission: 'reconciliations.view' },
    ],
  },
  {
    label: 'Accounting',
    icon: BookOpenCheck,
    items: [
      { label: 'Chart of accounts', to: '/accounting/accounts', permission: 'accounts.view' },
      { label: 'Inventory', to: '/accounting/inventory', permission: 'products.view' },
      { label: 'Sales tax', to: '/accounting/sales-tax', permission: 'reports.view' },
      { label: 'Journal entries', to: '/accounting/journals', permission: 'journals.view' },
      { label: 'Periods & close', to: '/accounting/periods', permission: 'periods.view' },
    ],
  },
  {
    label: 'Documents',
    icon: FileText,
    items: [{ label: 'Attachments', to: '/documents', permission: 'attachments.view' }],
  },
  {
    label: 'Reports',
    icon: BarChart3,
    items: [
      { label: 'All reports', to: '/reports', permission: 'reports.view' },
      { label: 'Audit log', to: '/reports/audit-log', permission: 'audit.view' },
    ],
  },
  {
    label: 'Settings',
    icon: Settings,
    items: [
      { label: 'Company', to: '/settings/company', permission: 'company.edit' },
      { label: 'Brand', to: '/settings/brand', permission: 'brand.edit' },
      { label: 'Users & roles', to: '/settings/users', permission: 'users.view' },
      { label: 'Data export', to: '/settings/export', permission: 'exports.create' },
    ],
  },
];

/** Marker export so the icon import list stays used as groups grow. */
export const NAV_ICONS = { Banknote };
