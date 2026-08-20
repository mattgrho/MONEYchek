import {
  Banknote,
  BarChart3,
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
      { label: 'Products & services', to: '/sales/products', permission: 'products.view' },
    ],
  },
  // Expenses and Banking groups are appended as their phases pass their
  // gates — navigation never points at unimplemented routes.
  {
    label: 'Accounting',
    icon: BookOpenCheck,
    items: [
      { label: 'Chart of accounts', to: '/accounting/accounts', permission: 'accounts.view' },
      { label: 'Journal entries', to: '/accounting/journals', permission: 'journals.view' },
      { label: 'Periods & close', to: '/accounting/periods', permission: 'periods.view' },
    ],
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
    ],
  },
];

/** Marker export so the icon import list stays used as groups grow. */
export const NAV_ICONS = { Banknote };
