import { Router } from 'express';
import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import * as schema from '../db/schema/index';
import { orgCtx, requirePermission } from '../middleware/auth';
import { asyncHandler } from '../middleware/validate';
import { rateLimit } from '../middleware/rate-limit';
import { canonicalJson, writeAuditEvent } from '../accounting/audit';

export const exportsRouter = Router();

/**
 * Owner full-data export: every organization-scoped table streamed as one
 * documented JSON object with a manifest (schema version, row counts,
 * per-table checksums). Audited. This is data portability, not a tested
 * restorable backup (the restore runbook lives in README).
 */
const EXPORT_TABLES = {
  organizations: schema.organizations,
  company_profiles: schema.companyProfiles,
  brand_settings: schema.brandSettings,
  accounting_settings: schema.accountingSettings,
  sales_settings: schema.salesSettings,
  purchasing_settings: schema.purchasingSettings,
  roles: schema.roles,
  memberships: schema.memberships,
  number_sequences: schema.numberSequences,
  accounts: schema.accounts,
  fiscal_periods: schema.fiscalPeriods,
  journal_entries: schema.journalEntries,
  journal_lines: schema.journalLines,
  journal_links: schema.journalLinks,
  manual_journals: schema.manualJournals,
  customers: schema.customers,
  products_services: schema.productsServices,
  tax_rates: schema.taxRates,
  estimates: schema.estimates,
  estimate_lines: schema.estimateLines,
  invoices: schema.invoices,
  invoice_lines: schema.invoiceLines,
  customer_payments: schema.customerPayments,
  customer_payment_allocations: schema.customerPaymentAllocations,
  credit_memos: schema.creditMemos,
  credit_memo_lines: schema.creditMemoLines,
  credit_allocations: schema.creditAllocations,
  customer_refunds: schema.customerRefunds,
  invoice_write_offs: schema.invoiceWriteOffs,
  sales_receipts: schema.salesReceipts,
  sales_receipt_lines: schema.salesReceiptLines,
  deposits: schema.deposits,
  deposit_components: schema.depositComponents,
  vendors: schema.vendors,
  bills: schema.bills,
  bill_lines: schema.billLines,
  vendor_credits: schema.vendorCredits,
  vendor_credit_lines: schema.vendorCreditLines,
  vendor_credit_allocations: schema.vendorCreditAllocations,
  bill_payments: schema.billPayments,
  bill_payment_allocations: schema.billPaymentAllocations,
  expenses: schema.expenses,
  expense_lines: schema.expenseLines,
  inventory_layers: schema.inventoryLayers,
  inventory_consumptions: schema.inventoryConsumptions,
  financial_account_metadata: schema.financialAccountMetadata,
  bank_import_batches: schema.bankImportBatches,
  bank_feed_items: schema.bankFeedItems,
  bank_rules: schema.bankRules,
  bank_rule_applications: schema.bankRuleApplications,
  reconciliations: schema.reconciliations,
  reconciliation_items: schema.reconciliationItems,
  audit_events: schema.auditEvents,
  attachments: schema.attachments,
  entity_attachments: schema.entityAttachments,
} as const;

exportsRouter.get(
  '/exports/full',
  requirePermission('exports.create'),
  rateLimit({ name: 'exports', limit: 5, windowSeconds: 3600 }),
  asyncHandler(async (req, res) => {
    const ctx = orgCtx(req);
    const db = getDb();

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="company-export-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    res.setHeader('Cache-Control', 'no-store, private');

    const manifest: Record<string, { rows: number; sha256: string }> = {};
    res.write(
      `{"format":"ledgeros-full-export","schemaVersion":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"organizationId":${JSON.stringify(ctx.organizationId)},"tables":{`,
    );
    let first = true;
    for (const [name, table] of Object.entries(EXPORT_TABLES)) {
      let rows: unknown[];
      if (name === 'organizations') {
        rows = await db
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, ctx.organizationId));
      } else {
        // Every export table carries organization_id (enforced by schema).
        rows = await db
          .select()
          .from(table as typeof schema.customers)
          .where(sql`organization_id = ${ctx.organizationId}`);
      }
      const json = JSON.stringify(rows);
      manifest[name] = {
        rows: rows.length,
        sha256: createHash('sha256').update(canonicalJson(rows)).digest('hex'),
      };
      res.write(`${first ? '' : ','}${JSON.stringify(name)}:${json}`);
      first = false;
    }
    res.write(`},"manifest":${JSON.stringify(manifest)}}`);
    res.end();

    await db.transaction(async (tx) => {
      await writeAuditEvent(tx, {
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        actorRole: ctx.roleKey,
        action: 'export.full',
        entityType: 'export',
        payload: {
          tables: Object.keys(manifest).length,
          totalRows: Object.values(manifest).reduce((a, m) => a + m.rows, 0),
        },
        correlationId: req.correlationId,
      });
    });
  }),
);
