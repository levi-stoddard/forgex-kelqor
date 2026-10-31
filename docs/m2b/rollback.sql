-- Undoes migrations 0004 and 0005 (Milestone 2B) in place. Run it with `npm run db:rollback-m2b -- --confirm`, which
-- runs it in one transaction and supplies the timestamp drizzle recorded for migration 0004.
-- It removes every migration from 0004 on, so it also undoes later milestones' tables (M3's 0006) first.
-- Later milestones' tables first (M4's 0007), since every migration record from this one on is removed.
DROP TABLE IF EXISTS "invoice_lines", "invoices", "service_events", "service_requests", "customer_services" CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_freeze"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_lines_freeze"() CASCADE;
DROP TABLE IF EXISTS "eng_events", "eng_missions", "eng_workspaces" CASCADE;
DROP TABLE IF EXISTS "discovery_figures", "industry_intelligence", "research_records", "research_sources", "ai_usage_ledger", "spending_reconciliations", "mission_approvals", "mission_steps", "missions" CASCADE;
DROP INDEX IF EXISTS "users_one_spending_authority_idx";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_spending_authority_check";
ALTER TABLE "users" DROP COLUMN IF EXISTS "spending_authority_at";
ALTER TABLE "users" DROP COLUMN IF EXISTS "sign_in_disabled_at";
-- Functions created by migration 0005 (its triggers went with their tables above):
DROP FUNCTION IF EXISTS "kelqor_refuse_removal"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_ledger_update"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_approval_update"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_refuse_update"() CASCADE;
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" >= :m2b_since;
