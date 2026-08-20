CREATE TABLE "customer_retainers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"posting_status" text DEFAULT 'draft' NOT NULL,
	"received_date" date NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"deposit_to_account_id" uuid NOT NULL,
	"method" text,
	"reference" text,
	"memo" text,
	"journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"posted_by_user_id" uuid,
	"voided_at" timestamp with time zone,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retainer_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"retainer_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(20, 4) NOT NULL,
	"effective_date" date NOT NULL,
	"reversal_of_application_id" uuid,
	"journal_entry_id" uuid,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"decision" text NOT NULL,
	"decided_by_user_id" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"product_id" uuid,
	"account_id" uuid,
	"description" text DEFAULT '' NOT NULL,
	"quantity" numeric(20, 6) DEFAULT '1' NOT NULL,
	"unit_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"amount" numeric(20, 4) DEFAULT '0' NOT NULL,
	"billed_quantity" numeric(20, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"po_date" date NOT NULL,
	"expected_date" date,
	"ship_to" text,
	"memo" text,
	"vendor_message" text,
	"total" numeric(20, 4) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_settings" ADD COLUMN "customer_retainers_account_id" uuid;--> statement-breakpoint
ALTER TABLE "purchasing_settings" ADD COLUMN "approval_mode" text DEFAULT 'one_step' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "returned_date" date;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "returned_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "returned_reason" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "return_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_deposit_to_account_id_accounts_id_fk" FOREIGN KEY ("deposit_to_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_retainers" ADD CONSTRAINT "customer_retainers_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_retainer_id_customer_retainers_id_fk" FOREIGN KEY ("retainer_id") REFERENCES "public"."customer_retainers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retainer_applications" ADD CONSTRAINT "retainer_applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_approvals" ADD CONSTRAINT "bill_approvals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_approvals" ADD CONSTRAINT "bill_approvals_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_approvals" ADD CONSTRAINT "bill_approvals_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_product_id_products_services_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_retainers_org_number_uq" ON "customer_retainers" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "customer_retainers_org_customer_idx" ON "customer_retainers" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "retainer_apps_org_retainer_idx" ON "retainer_applications" USING btree ("organization_id","retainer_id","effective_date");--> statement-breakpoint
CREATE INDEX "retainer_apps_org_invoice_idx" ON "retainer_applications" USING btree ("organization_id","invoice_id","effective_date");--> statement-breakpoint
CREATE INDEX "retainer_apps_retainer_idx" ON "retainer_applications" USING btree ("retainer_id");--> statement-breakpoint
CREATE INDEX "retainer_apps_invoice_idx" ON "retainer_applications" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "bill_approvals_bill_idx" ON "bill_approvals" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "po_lines_po_line_uq" ON "purchase_order_lines" USING btree ("purchase_order_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_org_number_uq" ON "purchase_orders" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_vendor_idx" ON "purchase_orders" USING btree ("organization_id","vendor_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_status_idx" ON "purchase_orders" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_returned_by_user_id_users_id_fk" FOREIGN KEY ("returned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_return_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("return_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;;--> statement-breakpoint
-- Backfill new permission keys onto existing system role presets (owner and
-- company_admin hold '*'; customized roles keep their edits — keys are only
-- appended, deduplicated).
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (
    SELECT jsonb_array_elements_text(permissions || '["purchase_orders.view","purchase_orders.create","purchase_orders.edit","purchase_orders.void"]'::jsonb) AS v
  ) s
) WHERE is_system = true AND key IN ('ap_manager', 'finance_admin', 'accountant', 'bookkeeper');--> statement-breakpoint
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (
    SELECT jsonb_array_elements_text(permissions || '["purchase_orders.view","purchase_orders.create","purchase_orders.edit"]'::jsonb) AS v
  ) s
) WHERE is_system = true AND key = 'bill_clerk';--> statement-breakpoint
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (
    SELECT jsonb_array_elements_text(permissions || '["retainers.view","retainers.create","retainers.edit","retainers.post","retainers.void"]'::jsonb) AS v
  ) s
) WHERE is_system = true AND key IN ('ar_manager', 'finance_admin', 'accountant', 'bookkeeper');--> statement-breakpoint
UPDATE roles SET permissions = (
  SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb) FROM (
    SELECT jsonb_array_elements_text(permissions || '["purchase_orders.view","retainers.view"]'::jsonb) AS v
  ) s
) WHERE is_system = true AND key = 'auditor';
