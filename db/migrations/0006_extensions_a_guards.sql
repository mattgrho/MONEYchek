-- Append-only protection for the extension-A history tables, matching the
-- discipline in 0001_invariants.sql: allocation/approval history is never
-- edited or deleted, only extended with reversing rows.

CREATE TRIGGER retainer_apps_no_update_trg
  BEFORE UPDATE ON retainer_applications
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER retainer_apps_no_delete_trg
  BEFORE DELETE ON retainer_applications
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

CREATE TRIGGER bill_approvals_no_update_trg
  BEFORE UPDATE ON bill_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint
CREATE TRIGGER bill_approvals_no_delete_trg
  BEFORE DELETE ON bill_approvals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();--> statement-breakpoint

-- Retainer rows and applications carry money; keep the same sign discipline
-- the ledger uses (applications may be negative only as reversals).
ALTER TABLE customer_retainers
  ADD CONSTRAINT customer_retainers_amount_positive CHECK (amount > 0);--> statement-breakpoint
ALTER TABLE retainer_applications
  ADD CONSTRAINT retainer_apps_amount_sign CHECK (
    (reversal_of_application_id IS NULL AND amount > 0)
    OR (reversal_of_application_id IS NOT NULL AND amount < 0)
  );
