CREATE INDEX "ca_invoice_idx" ON "credit_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "ca_credit_memo_idx" ON "credit_allocations" USING btree ("credit_memo_id");--> statement-breakpoint
CREATE INDEX "cpa_invoice_idx" ON "customer_payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "cpa_payment_idx" ON "customer_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "customer_refunds_src_idx" ON "customer_refunds" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "write_offs_invoice_idx" ON "invoice_write_offs" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "bpa_bill_idx" ON "bill_payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "bpa_payment_idx" ON "bill_payment_allocations" USING btree ("bill_payment_id");--> statement-breakpoint
CREATE INDEX "vca_bill_idx" ON "vendor_credit_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "vca_credit_idx" ON "vendor_credit_allocations" USING btree ("vendor_credit_id");