-- Milestone 4: an invoice is frozen once it leaves draft, as the ledger is in 0005. Its total, month, customer and
-- simulated flag can't change and it can't be deleted; its lines can't be added, changed or removed. The only moves
-- are draft→issued (when the total equals its lines), draft→void, issued→paid and issued→void. Corrections are a
-- new invoice that replaces a voided one.
CREATE OR REPLACE FUNCTION "kelqor_invoice_freeze"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'An issued or closed invoice can''t be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.period <> OLD.period OR NEW.simulated <> OLD.simulated OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'An invoice''s customer, month, number and simulated flag never change';
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'issued', 'void') THEN
      RAISE EXCEPTION 'A draft invoice can only be issued or voided';
    END IF;
    IF NEW.status = 'issued' AND NEW.total_cents <> (SELECT COALESCE(SUM(amount_cents), 0) FROM invoice_lines WHERE invoice_id = NEW.id) THEN
      RAISE EXCEPTION 'An invoice''s total must equal its lines when it is issued';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.total_cents <> OLD.total_cents OR NEW.issued_at IS DISTINCT FROM OLD.issued_at OR NEW.replaces_invoice_id IS DISTINCT FROM OLD.replaces_invoice_id THEN
    RAISE EXCEPTION 'An issued invoice can''t be changed';
  END IF;
  IF NOT (NEW.status = OLD.status OR (OLD.status = 'issued' AND NEW.status IN ('paid', 'void'))) THEN
    RAISE EXCEPTION 'That invoice status change isn''t allowed';
  END IF;
  IF NEW.paid_at IS DISTINCT FROM OLD.paid_at AND NOT (OLD.status = 'issued' AND NEW.status = 'paid') THEN
    RAISE EXCEPTION 'A payment is recorded only when an issued invoice is paid';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "invoices_freeze" BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION "kelqor_invoice_freeze"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "kelqor_invoice_lines_freeze"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A line never moves between invoices or customers, and every invoice it touches must still be a draft.
  IF TG_OP = 'UPDATE' AND (NEW.invoice_id <> OLD.invoice_id OR NEW.org_id <> OLD.org_id) THEN
    RAISE EXCEPTION 'An invoice line can''t move to another invoice or customer';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND (SELECT status FROM invoices WHERE id = OLD.invoice_id) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of an issued or closed invoice can''t be changed';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (SELECT status FROM invoices WHERE id = NEW.invoice_id) IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'The lines of an issued or closed invoice can''t be changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_freeze" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION "kelqor_invoice_lines_freeze"();
--> statement-breakpoint
-- Row triggers don't see TRUNCATE; refuse it outright on both tables (the 0005 pattern).
CREATE TRIGGER "invoices_no_truncate" BEFORE TRUNCATE ON "invoices" FOR EACH STATEMENT EXECUTE FUNCTION "kelqor_refuse_removal"();
--> statement-breakpoint
CREATE TRIGGER "invoice_lines_no_truncate" BEFORE TRUNCATE ON "invoice_lines" FOR EACH STATEMENT EXECUTE FUNCTION "kelqor_refuse_removal"();
