import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/client';
import {
  accountingSettings,
  accounts,
  journalLines,
  type AccountCategory,
} from '../db/schema/index';
import { AppError } from '../lib/errors';

export const NORMAL_BALANCE: Record<AccountCategory, 'debit' | 'credit'> = {
  asset: 'debit',
  contra_asset: 'credit',
  liability: 'credit',
  equity: 'credit',
  contra_equity: 'debit',
  income: 'credit',
  contra_income: 'debit',
  cogs: 'debit',
  expense: 'debit',
  other_income: 'credit',
  other_expense: 'debit',
};

export interface SystemAccountDef {
  key: string;
  name: string;
  number: string;
  category: AccountCategory;
  detailType: string;
  settingsColumn:
    | 'arAccountId'
    | 'apAccountId'
    | 'undepositedFundsAccountId'
    | 'openingBalanceEquityAccountId'
    | 'retainedEarningsAccountId'
    | 'salesTaxPayableAccountId'
    | 'inventoryAssetAccountId'
    | 'inventoryAdjustmentAccountId'
    | 'cogsAccountId'
    | 'defaultIncomeAccountId'
    | 'defaultExpenseAccountId'
    | 'badDebtAccountId';
}

/** Protected accounts every organization gets. Types are locked forever. */
export const SYSTEM_ACCOUNTS: SystemAccountDef[] = [
  {
    key: 'accounts_receivable',
    name: 'Accounts Receivable',
    number: '1200',
    category: 'asset',
    detailType: 'accounts_receivable',
    settingsColumn: 'arAccountId',
  },
  {
    key: 'undeposited_funds',
    name: 'Undeposited Funds',
    number: '1250',
    category: 'asset',
    detailType: 'undeposited_funds',
    settingsColumn: 'undepositedFundsAccountId',
  },
  {
    key: 'inventory_asset',
    name: 'Inventory Asset',
    number: '1300',
    category: 'asset',
    detailType: 'inventory',
    settingsColumn: 'inventoryAssetAccountId',
  },
  {
    key: 'accounts_payable',
    name: 'Accounts Payable',
    number: '2000',
    category: 'liability',
    detailType: 'accounts_payable',
    settingsColumn: 'apAccountId',
  },
  {
    key: 'sales_tax_payable',
    name: 'Sales Tax Payable',
    number: '2200',
    category: 'liability',
    detailType: 'sales_tax_payable',
    settingsColumn: 'salesTaxPayableAccountId',
  },
  {
    key: 'opening_balance_equity',
    name: 'Opening Balance Equity',
    number: '3000',
    category: 'equity',
    detailType: 'opening_balance_equity',
    settingsColumn: 'openingBalanceEquityAccountId',
  },
  {
    key: 'retained_earnings',
    name: 'Retained Earnings',
    number: '3900',
    category: 'equity',
    detailType: 'retained_earnings',
    settingsColumn: 'retainedEarningsAccountId',
  },
  {
    key: 'inventory_adjustment',
    name: 'Inventory Adjustments',
    number: '5900',
    category: 'cogs',
    detailType: 'inventory_adjustment',
    settingsColumn: 'inventoryAdjustmentAccountId',
  },
  {
    key: 'cogs',
    name: 'Cost of Goods Sold',
    number: '5000',
    category: 'cogs',
    detailType: 'cogs',
    settingsColumn: 'cogsAccountId',
  },
  {
    key: 'bad_debt',
    name: 'Bad Debt Expense',
    number: '6900',
    category: 'expense',
    detailType: 'bad_debt',
    settingsColumn: 'badDebtAccountId',
  },
];

interface TemplateAccount {
  number: string;
  name: string;
  category: AccountCategory;
  detailType: string;
}

/** Industry chart-of-accounts starting points (editable, not hardcoded behavior). */
export const COA_TEMPLATES: Record<string, { name: string; accounts: TemplateAccount[] }> = {
  general_service: {
    name: 'General service business',
    accounts: [
      { number: '1000', name: 'Checking', category: 'asset', detailType: 'bank' },
      { number: '1010', name: 'Savings', category: 'asset', detailType: 'bank' },
      {
        number: '2100',
        name: 'Business Credit Card',
        category: 'liability',
        detailType: 'credit_card',
      },
      { number: '3100', name: 'Owner Equity', category: 'equity', detailType: 'owner_equity' },
      { number: '3200', name: 'Owner Draw', category: 'contra_equity', detailType: 'owner_draw' },
      { number: '4000', name: 'Service Income', category: 'income', detailType: 'service_income' },
      {
        number: '4100',
        name: 'Other Operating Income',
        category: 'income',
        detailType: 'other_income',
      },
      {
        number: '4900',
        name: 'Discounts Given',
        category: 'contra_income',
        detailType: 'discounts',
      },
      {
        number: '6000',
        name: 'Advertising & Marketing',
        category: 'expense',
        detailType: 'advertising',
      },
      { number: '6100', name: 'Insurance', category: 'expense', detailType: 'insurance' },
      {
        number: '6200',
        name: 'Office Supplies & Software',
        category: 'expense',
        detailType: 'office',
      },
      { number: '6300', name: 'Rent & Lease', category: 'expense', detailType: 'rent' },
      { number: '6400', name: 'Utilities', category: 'expense', detailType: 'utilities' },
      {
        number: '6500',
        name: 'Professional Fees',
        category: 'expense',
        detailType: 'professional_fees',
      },
      { number: '6600', name: 'Travel', category: 'expense', detailType: 'travel' },
      { number: '6700', name: 'Meals', category: 'expense', detailType: 'meals' },
      { number: '6800', name: 'Bank Fees', category: 'expense', detailType: 'bank_charges' },
      {
        number: '7000',
        name: 'Interest Income',
        category: 'other_income',
        detailType: 'interest_income',
      },
      {
        number: '7100',
        name: 'Interest Expense',
        category: 'other_expense',
        detailType: 'interest_expense',
      },
    ],
  },
  contractor: {
    name: 'Contractor / construction / restoration',
    accounts: [
      { number: '1000', name: 'Checking', category: 'asset', detailType: 'bank' },
      {
        number: '2100',
        name: 'Business Credit Card',
        category: 'liability',
        detailType: 'credit_card',
      },
      { number: '3100', name: 'Owner Equity', category: 'equity', detailType: 'owner_equity' },
      { number: '3200', name: 'Owner Draw', category: 'contra_equity', detailType: 'owner_draw' },
      { number: '4000', name: 'Contract Income', category: 'income', detailType: 'service_income' },
      {
        number: '4100',
        name: 'Change Order Income',
        category: 'income',
        detailType: 'service_income',
      },
      {
        number: '4900',
        name: 'Discounts Given',
        category: 'contra_income',
        detailType: 'discounts',
      },
      { number: '5100', name: 'Direct Materials', category: 'cogs', detailType: 'materials' },
      {
        number: '5200',
        name: 'Subcontractor Costs',
        category: 'cogs',
        detailType: 'subcontractors',
      },
      { number: '5300', name: 'Direct Labor', category: 'cogs', detailType: 'direct_labor' },
      {
        number: '5400',
        name: 'Equipment Rental (Jobs)',
        category: 'cogs',
        detailType: 'equipment',
      },
      { number: '5500', name: 'Permits & Fees (Jobs)', category: 'cogs', detailType: 'permits' },
      {
        number: '6000',
        name: 'Advertising & Marketing',
        category: 'expense',
        detailType: 'advertising',
      },
      { number: '6100', name: 'Insurance', category: 'expense', detailType: 'insurance' },
      {
        number: '6200',
        name: 'Office Supplies & Software',
        category: 'expense',
        detailType: 'office',
      },
      { number: '6300', name: 'Rent & Lease', category: 'expense', detailType: 'rent' },
      { number: '6350', name: 'Vehicles & Fuel', category: 'expense', detailType: 'vehicles' },
      { number: '6400', name: 'Utilities', category: 'expense', detailType: 'utilities' },
      {
        number: '6500',
        name: 'Professional Fees',
        category: 'expense',
        detailType: 'professional_fees',
      },
      { number: '6800', name: 'Bank Fees', category: 'expense', detailType: 'bank_charges' },
      { number: '6850', name: 'Warranty Expense', category: 'expense', detailType: 'warranty' },
      {
        number: '7100',
        name: 'Interest Expense',
        category: 'other_expense',
        detailType: 'interest_expense',
      },
    ],
  },
  professional_services: {
    name: 'Professional services',
    accounts: [
      { number: '1000', name: 'Operating Checking', category: 'asset', detailType: 'bank' },
      {
        number: '2100',
        name: 'Business Credit Card',
        category: 'liability',
        detailType: 'credit_card',
      },
      { number: '3100', name: 'Owner Equity', category: 'equity', detailType: 'owner_equity' },
      { number: '3200', name: 'Owner Draw', category: 'contra_equity', detailType: 'owner_draw' },
      {
        number: '4000',
        name: 'Consulting Income',
        category: 'income',
        detailType: 'service_income',
      },
      { number: '4100', name: 'Retainer Income', category: 'income', detailType: 'service_income' },
      {
        number: '4900',
        name: 'Discounts Given',
        category: 'contra_income',
        detailType: 'discounts',
      },
      {
        number: '6000',
        name: 'Advertising & Marketing',
        category: 'expense',
        detailType: 'advertising',
      },
      { number: '6100', name: 'Insurance', category: 'expense', detailType: 'insurance' },
      {
        number: '6200',
        name: 'Software & Subscriptions',
        category: 'expense',
        detailType: 'office',
      },
      { number: '6300', name: 'Rent & Lease', category: 'expense', detailType: 'rent' },
      {
        number: '6500',
        name: 'Professional Fees',
        category: 'expense',
        detailType: 'professional_fees',
      },
      {
        number: '6550',
        name: 'Continuing Education',
        category: 'expense',
        detailType: 'education',
      },
      { number: '6600', name: 'Travel', category: 'expense', detailType: 'travel' },
      { number: '6800', name: 'Bank Fees', category: 'expense', detailType: 'bank_charges' },
    ],
  },
  retail: {
    name: 'Retail / light inventory',
    accounts: [
      { number: '1000', name: 'Checking', category: 'asset', detailType: 'bank' },
      {
        number: '2100',
        name: 'Business Credit Card',
        category: 'liability',
        detailType: 'credit_card',
      },
      { number: '3100', name: 'Owner Equity', category: 'equity', detailType: 'owner_equity' },
      { number: '3200', name: 'Owner Draw', category: 'contra_equity', detailType: 'owner_draw' },
      { number: '4000', name: 'Product Sales', category: 'income', detailType: 'product_sales' },
      { number: '4100', name: 'Service Income', category: 'income', detailType: 'service_income' },
      {
        number: '4800',
        name: 'Returns & Allowances',
        category: 'contra_income',
        detailType: 'returns',
      },
      {
        number: '4900',
        name: 'Discounts Given',
        category: 'contra_income',
        detailType: 'discounts',
      },
      {
        number: '5100',
        name: 'Freight & Shipping (COGS)',
        category: 'cogs',
        detailType: 'freight',
      },
      {
        number: '6000',
        name: 'Advertising & Marketing',
        category: 'expense',
        detailType: 'advertising',
      },
      { number: '6100', name: 'Insurance', category: 'expense', detailType: 'insurance' },
      { number: '6200', name: 'Store Supplies', category: 'expense', detailType: 'office' },
      { number: '6300', name: 'Rent & Lease', category: 'expense', detailType: 'rent' },
      { number: '6400', name: 'Utilities', category: 'expense', detailType: 'utilities' },
      {
        number: '6800',
        name: 'Bank Fees & Card Processing',
        category: 'expense',
        detailType: 'bank_charges',
      },
    ],
  },
};

/** Creates all protected system accounts and records them in settings. */
export async function ensureSystemAccounts(
  tx: Tx,
  organizationId: string,
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const def of SYSTEM_ACCOUNTS) {
    const existing = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemKey, def.key)))
      .limit(1);
    if (existing[0]) {
      ids[def.key] = existing[0].id;
      continue;
    }
    const [row] = await tx
      .insert(accounts)
      .values({
        organizationId,
        number: def.number,
        name: def.name,
        category: def.category,
        detailType: def.detailType,
        normalBalance: NORMAL_BALANCE[def.category],
        systemKey: def.key,
        postable: true,
        active: true,
      })
      .returning({ id: accounts.id });
    ids[def.key] = row!.id;
  }
  await tx
    .update(accountingSettings)
    .set(
      Object.fromEntries(
        SYSTEM_ACCOUNTS.map((def) => [def.settingsColumn, ids[def.key]]),
      ) as Record<string, string>,
    )
    .where(eq(accountingSettings.organizationId, organizationId));
  return ids;
}

/** Applies a chart template (plus system accounts) during onboarding. */
export async function applyChartTemplate(
  tx: Tx,
  organizationId: string,
  templateKey: string,
): Promise<void> {
  const template = COA_TEMPLATES[templateKey];
  if (!template) {
    throw AppError.validation('Unknown chart template', {
      templateKey: ['Choose a valid template'],
    });
  }
  await ensureSystemAccounts(tx, organizationId);
  for (const acc of template.accounts) {
    await tx
      .insert(accounts)
      .values({
        organizationId,
        number: acc.number,
        name: acc.name,
        category: acc.category,
        detailType: acc.detailType,
        normalBalance: NORMAL_BALANCE[acc.category],
        postable: true,
        active: true,
      })
      .onConflictDoNothing();
  }
  // Wire sensible defaults for income/expense mapping.
  const [income] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.category, 'income')))
    .orderBy(accounts.number)
    .limit(1);
  const [expense] = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.category, 'expense')))
    .orderBy(accounts.number)
    .limit(1);
  await tx
    .update(accountingSettings)
    .set({
      defaultIncomeAccountId: income?.id ?? null,
      defaultExpenseAccountId: expense?.id ?? null,
    })
    .where(eq(accountingSettings.organizationId, organizationId));
}

export async function getSystemAccountId(
  db: DbOrTx,
  organizationId: string,
  key: string,
): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, organizationId), eq(accounts.systemKey, key)))
    .limit(1);
  if (!row) {
    throw AppError.unprocessable(
      'SYSTEM_ACCOUNT_MISSING',
      `Protected account "${key}" is not set up yet; complete company onboarding first`,
    );
  }
  return row.id;
}

export async function accountHasActivity(db: DbOrTx, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(journalLines)
    .where(eq(journalLines.accountId, accountId))
    .limit(1);
  return Number(row?.count ?? 0) > 0;
}
