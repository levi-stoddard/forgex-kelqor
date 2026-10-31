-- Milestone 2B control rules (OWNER: the security reviewer agent): CHECK constraints and triggers for the mission, approval,
-- ledger and reconciliation tables (docs/m2b/PLAN.md). They hold whatever the code does: amounts can't be negative or
-- above the caps, simulated work is always $0 and never uses a real provider, an unverified charge always says why,
-- and ledger entries, approvals and reconciliation records are never deleted or rewritten. Rollback: drop the tables
-- (which drops their triggers), then the four kelqor_* functions below.

-- missions ---------------------------------------------------------------------------------------------------------
ALTER TABLE "missions" ADD CONSTRAINT "missions_status_check" CHECK ("status" IN ('draft', 'awaiting_approval', 'approved', 'running', 'verification', 'completed', 'completed_with_issues', 'needs_review', 'interrupted', 'budget_blocked', 'rejected', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_type_check" CHECK ("type" IN ('company_research', 'industry_research'));--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_provider_check" CHECK ("provider" IN ('google', 'anthropic', 'simulation', 'synthetic'));--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_thinking_level_check" CHECK ("thinking_level" IN ('low', 'medium', 'high'));--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_output_limit_check" CHECK ("max_output_tokens" BETWEEN 1 AND 20000);--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_review_shape_check" CHECK ("review" IS NULL OR jsonb_typeof("review") = 'null' OR (jsonb_typeof("review") = 'object' AND ("review"->>'provider') IN ('anthropic', 'simulation', 'synthetic') AND jsonb_typeof("review"->'maxCostMicros') = 'number' AND ("review"->>'maxCostMicros')::numeric BETWEEN 0 AND 2000000));--> statement-breakpoint
-- The research maximum plus the review maximum stay within the $2 mission limit.
ALTER TABLE "missions" ADD CONSTRAINT "missions_cost_check" CHECK ("max_cost_micros" BETWEEN 0 AND 2000000 AND "max_cost_micros" + coalesce(CASE WHEN jsonb_typeof("review") = 'object' THEN ("review"->>'maxCostMicros')::numeric END, 0) <= 2000000);--> statement-breakpoint
-- A simulated mission uses the simulated provider and reviewer only; a real one never does.
ALTER TABLE "missions" ADD CONSTRAINT "missions_simulated_check" CHECK ("simulated" = ("provider" = 'simulation') AND (jsonb_typeof("review") IS DISTINCT FROM 'object' OR (("review"->>'provider') = 'simulation') = "simulated"));--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_run_check" CHECK ("status" NOT IN ('running', 'verification') OR "run_id" IS NOT NULL);--> statement-breakpoint
-- An ended mission keeps no page text.
ALTER TABLE "missions" ADD CONSTRAINT "missions_working_state_check" CHECK ("status" NOT IN ('completed', 'completed_with_issues', 'rejected', 'failed', 'cancelled') OR "working_state" IS NULL OR jsonb_typeof("working_state") = 'null');--> statement-breakpoint

-- mission_approvals ------------------------------------------------------------------------------------------------
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_kind_check" CHECK ("kind" IN ('mission', 'review'));--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_max_check" CHECK ("max_cost_micros" BETWEEN 0 AND 2000000);--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_expiry_check" CHECK ("expires_at" > "approved_at" AND "expires_at" <= "approved_at" + interval '25 hours' AND "boise_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_void_check" CHECK (("voided_at" IS NULL) = ("void_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_review_check" CHECK ("kind" <> 'review' OR jsonb_typeof("review") = 'object');--> statement-breakpoint

-- ai_usage_ledger --------------------------------------------------------------------------------------------------
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_status_check" CHECK ("status" IN ('reserved', 'settled', 'not_billed', 'unverified'));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_purpose_check" CHECK ("purpose" IN ('research', 'repair', 'retry', 'review', 'count', 'adjustment'));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_provider_check" CHECK ("provider" IN ('google', 'anthropic', 'simulation', 'synthetic'));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_attempt_check" CHECK ("attempt" BETWEEN 1 AND 3);--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_amounts_check" CHECK ("reserved_micros" >= 0 AND ("actual_micros" IS NULL OR "actual_micros" >= 0) AND "counted_input_tokens" >= 0 AND "reserved_input_tokens" >= "counted_input_tokens");--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_output_check" CHECK ("purpose" = 'adjustment' OR "max_output_tokens" BETWEEN 1 AND 20000);--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_released_check" CHECK ("released_micros" >= 0 AND "released_micros" <= "reserved_micros" AND ("released_micros" = 0 OR "status" = 'unverified'));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_settled_check" CHECK (("status" <> 'settled' OR "actual_micros" IS NOT NULL) AND ("status" = 'reserved' OR "settled_at" IS NOT NULL));--> statement-breakpoint
-- An unverified charge always records why (a mission can complete only when every entry is accounted for).
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_unverified_check" CHECK ("status" <> 'unverified' OR "error_kind" IS NOT NULL);--> statement-breakpoint
-- Simulated entries are $0 and from the simulated provider; synthetic entries come only from the test provider.
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_simulated_check" CHECK (NOT ("simulated" AND "synthetic") AND "simulated" = ("provider" = 'simulation') AND "synthetic" = ("provider" = 'synthetic') AND (NOT "simulated" OR ("reserved_micros" = 0 AND coalesce("actual_micros", 0) = 0)));--> statement-breakpoint
-- A token count reserves nothing; an adjustment belongs to a reconciliation, every other entry to a mission approval.
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_count_check" CHECK ("purpose" <> 'count' OR "reserved_micros" = 0);--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_owner_check" CHECK (("purpose" = 'adjustment') = ("mission_id" IS NULL) AND ("purpose" = 'adjustment') = ("reconciliation_id" IS NOT NULL) AND ("purpose" = 'adjustment' OR ("approval_id" IS NOT NULL AND "step_id" IS NOT NULL)));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_period_check" CHECK ("boise_day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND "boise_month" = substr("boise_day", 1, 7));--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_review_check" CHECK ("provider_review_id" IS NULL OR "over_reservation");--> statement-breakpoint

-- spending_reconciliations -----------------------------------------------------------------------------------------
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_kind_check" CHECK ("kind" IN ('figure', 'release', 'adjustment', 'unblock'));--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_provider_check" CHECK ("provider" IN ('google', 'anthropic', 'simulation', 'synthetic'));--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_period_check" CHECK ((("kind" = 'unblock') = ("period_kind" IS NULL)) AND (("period_kind" IS NULL) = ("period" IS NULL)) AND ("period_kind" IS NULL OR ("period_kind" = 'day' AND "period" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR ("period_kind" = 'month' AND "period" ~ '^[0-9]{4}-[0-9]{2}$')));--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_note_check" CHECK (length(btrim("note")) > 0);--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_amounts_check" CHECK ("settled_micros" >= 0 AND "unverified_micros" >= 0 AND "released_micros" >= 0 AND "adjustment_micros" >= 0 AND ("kind" <> 'figure' OR ("provider_micros" IS NOT NULL AND "provider_micros" >= 0)) AND ("kind" <> 'release' OR "released_micros" > 0) AND ("kind" <> 'adjustment' OR "adjustment_micros" > 0));--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_figure_check" CHECK (("kind" IN ('release', 'adjustment')) = ("figure_id" IS NOT NULL));--> statement-breakpoint

-- Append-only records ----------------------------------------------------------------------------------------------
CREATE FUNCTION "kelqor_refuse_removal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KELQOR keeps every % record: it is never deleted or truncated', TG_TABLE_NAME;
END
$$;--> statement-breakpoint
-- A ledger entry's identity, prices and reservation never change; it leaves "reserved" once, and its outcome is then
-- final. Afterwards only a reconciliation release (upward) and a provider review (once) may still be recorded.
CREATE FUNCTION "kelqor_ledger_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.seq, NEW.mission_id, NEW.approval_id, NEW.step_id, NEW.attempt, NEW.purpose, NEW.provider, NEW.model, NEW.price_version, NEW.prices,
      NEW.sent_at, NEW.boise_day, NEW.boise_month, NEW.max_output_tokens, NEW.reserved_micros, NEW.simulated, NEW.synthetic, NEW.backend_instance,
      NEW.reconciliation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.seq, OLD.mission_id, OLD.approval_id, OLD.step_id, OLD.attempt, OLD.purpose, OLD.provider, OLD.model, OLD.price_version, OLD.prices,
      OLD.sent_at, OLD.boise_day, OLD.boise_month, OLD.max_output_tokens, OLD.reserved_micros, OLD.simulated, OLD.synthetic, OLD.backend_instance,
      OLD.reconciliation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'KELQOR ledger entry %: its identity, prices and reservation never change', OLD.id;
  END IF;
  IF (NEW.counted_input_tokens, NEW.reserved_input_tokens) IS DISTINCT FROM (OLD.counted_input_tokens, OLD.reserved_input_tokens)
     AND NOT (OLD.purpose = 'count' AND OLD.status = 'reserved') THEN
    RAISE EXCEPTION 'KELQOR ledger entry %: its counted input never changes', OLD.id;
  END IF;
  IF OLD.status <> 'reserved' AND (NEW.status, NEW.usage, NEW.actual_micros, NEW.over_reservation, NEW.provider_request_id, NEW.error_kind, NEW.error_detail, NEW.settled_at)
     IS DISTINCT FROM (OLD.status, OLD.usage, OLD.actual_micros, OLD.over_reservation, OLD.provider_request_id, OLD.error_kind, OLD.error_detail, OLD.settled_at) THEN
    RAISE EXCEPTION 'KELQOR ledger entry %: a closed entry''s outcome never changes', OLD.id;
  END IF;
  IF NEW.released_micros < OLD.released_micros THEN
    RAISE EXCEPTION 'KELQOR ledger entry %: a release is never taken back', OLD.id;
  END IF;
  IF OLD.provider_review_id IS NOT NULL AND NEW.provider_review_id IS DISTINCT FROM OLD.provider_review_id THEN
    RAISE EXCEPTION 'KELQOR ledger entry %: its provider review is recorded once', OLD.id;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
-- An approval changes only to be voided, once, with its reason.
CREATE FUNCTION "kelqor_approval_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.mission_id, NEW.kind, NEW.scope_fingerprint, NEW.max_cost_micros, NEW.review, NEW.approved_by_id, NEW.approved_at, NEW.expires_at,
      NEW.boise_day, NEW.authority_granted_at, NEW.request_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.mission_id, OLD.kind, OLD.scope_fingerprint, OLD.max_cost_micros, OLD.review, OLD.approved_by_id, OLD.approved_at, OLD.expires_at,
      OLD.boise_day, OLD.authority_granted_at, OLD.request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'KELQOR approval %: what it approved never changes', OLD.id;
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at, NEW.void_reason) IS DISTINCT FROM (OLD.voided_at, OLD.void_reason) THEN
    RAISE EXCEPTION 'KELQOR approval %: a voided approval stays void', OLD.id;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE FUNCTION "kelqor_refuse_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'KELQOR % records are never changed; record a new one instead', TG_TABLE_NAME;
END
$$;--> statement-breakpoint
CREATE TRIGGER "ai_usage_ledger_no_delete" BEFORE DELETE ON "ai_usage_ledger" FOR EACH ROW EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "ai_usage_ledger_no_truncate" BEFORE TRUNCATE ON "ai_usage_ledger" FOR EACH STATEMENT EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "ai_usage_ledger_update" BEFORE UPDATE ON "ai_usage_ledger" FOR EACH ROW EXECUTE FUNCTION "kelqor_ledger_update"();--> statement-breakpoint
CREATE TRIGGER "mission_approvals_no_delete" BEFORE DELETE ON "mission_approvals" FOR EACH ROW EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "mission_approvals_no_truncate" BEFORE TRUNCATE ON "mission_approvals" FOR EACH STATEMENT EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "mission_approvals_update" BEFORE UPDATE ON "mission_approvals" FOR EACH ROW EXECUTE FUNCTION "kelqor_approval_update"();--> statement-breakpoint
CREATE TRIGGER "spending_reconciliations_no_delete" BEFORE DELETE ON "spending_reconciliations" FOR EACH ROW EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "spending_reconciliations_no_truncate" BEFORE TRUNCATE ON "spending_reconciliations" FOR EACH STATEMENT EXECUTE FUNCTION "kelqor_refuse_removal"();--> statement-breakpoint
CREATE TRIGGER "spending_reconciliations_no_update" BEFORE UPDATE ON "spending_reconciliations" FOR EACH ROW EXECUTE FUNCTION "kelqor_refuse_update"();
