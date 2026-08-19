-- Ledger invariants enforced in the database, independent of application code.
-- These protect the books even against buggy or bypassing application paths.

-- ---------------------------------------------------------------------------
-- 1. Journal line shape: exactly one positive side, never negative.
-- ---------------------------------------------------------------------------
ALTER TABLE journal_lines
  ADD CONSTRAINT journal_lines_one_side_chk
  CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  );

-- ---------------------------------------------------------------------------
-- 2. Entry balance: total debits must equal total credits, and every entry
--    must carry at least two lines. Deferred to commit so multi-row inserts
--    validate as a unit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_journal_entry_balance() RETURNS trigger AS $$
DECLARE
  v_entry uuid;
  v_debits numeric;
  v_credits numeric;
  v_count bigint;
BEGIN
  v_entry := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(l.debit), 0), COALESCE(SUM(l.credit), 0), COUNT(*)
    INTO v_debits, v_credits, v_count
    FROM journal_lines l
   WHERE l.entry_id = v_entry;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two lines', v_entry
      USING ERRCODE = '23514';
  END IF;
  IF v_debits IS DISTINCT FROM v_credits THEN
    RAISE EXCEPTION 'journal entry % is unbalanced (debits %, credits %)',
      v_entry, v_debits, v_credits USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balance_trg
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_journal_entry_balance();

CREATE OR REPLACE FUNCTION enforce_journal_entry_has_lines() RETURNS trigger AS $$
DECLARE
  v_count bigint;
BEGIN
  SELECT COUNT(*) INTO v_count FROM journal_lines l WHERE l.entry_id = NEW.id;
  IF v_count < 2 THEN
    RAISE EXCEPTION 'journal entry % must have at least two lines', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_entries_has_lines_trg
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_journal_entry_has_lines();

-- ---------------------------------------------------------------------------
-- 3. Append-only journal. Posted entries/lines cannot be deleted; the only
--    mutable entry field is the one-time reversal link, and the only mutable
--    line fields are the banking presentation flags (cleared,
--    reconciliation_id), which carry no monetary meaning.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are append-only (attempted %)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_no_delete_trg
  BEFORE DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION journal_entries_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.entry_number IS DISTINCT FROM OLD.entry_number
    OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.source_type IS DISTINCT FROM OLD.source_type
    OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
    OR NEW.memo IS DISTINCT FROM OLD.memo
    OR NEW.reversal_of_entry_id IS DISTINCT FROM OLD.reversal_of_entry_id
    OR NEW.posted_by_user_id IS DISTINCT FROM OLD.posted_by_user_id
    OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
    OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
    OR NEW.lines_hash IS DISTINCT FROM OLD.lines_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'posted journal entries are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.reversed_by_entry_id IS NOT NULL
     AND NEW.reversed_by_entry_id IS DISTINCT FROM OLD.reversed_by_entry_id THEN
    RAISE EXCEPTION 'reversal link cannot be changed once set' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_guard_update_trg
  BEFORE UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard_update();

CREATE TRIGGER journal_lines_no_delete_trg
  BEFORE DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION journal_lines_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
    OR NEW.line_number IS DISTINCT FROM OLD.line_number
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.debit IS DISTINCT FROM OLD.debit
    OR NEW.credit IS DISTINCT FROM OLD.credit
    OR NEW.party_type IS DISTINCT FROM OLD.party_type
    OR NEW.party_id IS DISTINCT FROM OLD.party_id
    OR NEW.product_id IS DISTINCT FROM OLD.product_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.class_id IS DISTINCT FROM OLD.class_id
    OR NEW.location_id IS DISTINCT FROM OLD.location_id
    OR NEW.memo IS DISTINCT FROM OLD.memo
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'posted journal lines are append-only' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_lines_guard_update_trg
  BEFORE UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard_update();

-- ---------------------------------------------------------------------------
-- 4. Immutable audit chain.
-- ---------------------------------------------------------------------------
CREATE TRIGGER audit_events_no_update_trg
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_delete_trg
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- 5. Append-only allocation history (AR and AP).
-- ---------------------------------------------------------------------------
CREATE TRIGGER cpa_no_update_trg
  BEFORE UPDATE ON customer_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER cpa_no_delete_trg
  BEFORE DELETE ON customer_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ca_no_update_trg
  BEFORE UPDATE ON credit_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ca_no_delete_trg
  BEFORE DELETE ON credit_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER bpa_no_update_trg
  BEFORE UPDATE ON bill_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER bpa_no_delete_trg
  BEFORE DELETE ON bill_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER vca_no_update_trg
  BEFORE UPDATE ON vendor_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER vca_no_delete_trg
  BEFORE DELETE ON vendor_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- 6. Shape checks.
-- ---------------------------------------------------------------------------
ALTER TABLE deployment_settings
  ADD CONSTRAINT deployment_settings_single_row_chk CHECK (id = 1);

ALTER TABLE fiscal_periods
  ADD CONSTRAINT fiscal_periods_range_chk CHECK (end_date >= start_date);

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_nonnegative_chk
  CHECK (remaining_quantity >= 0 AND remaining_value >= 0);

ALTER TABLE inventory_layers
  ADD CONSTRAINT inventory_layers_positive_receipt_chk
  CHECK (original_quantity > 0);

ALTER TABLE inventory_consumptions
  ADD CONSTRAINT inventory_consumptions_nonzero_chk CHECK (quantity <> 0);

ALTER TABLE customer_payments
  ADD CONSTRAINT customer_payments_amount_chk CHECK (amount >= 0);

ALTER TABLE bill_payments
  ADD CONSTRAINT bill_payments_amount_chk CHECK (amount >= 0);

ALTER TABLE company_profiles
  ADD CONSTRAINT company_profiles_fy_month_chk
  CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

ALTER TABLE tax_rates
  ADD CONSTRAINT tax_rates_rate_chk CHECK (rate >= 0 AND rate < 1);
