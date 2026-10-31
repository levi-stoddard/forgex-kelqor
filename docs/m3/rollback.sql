-- Undoes migration 0006 (Milestone 3, engineering missions) in place, leaving M2B and everything earlier as it is.
-- Run it with `npm run db:rollback-m3 -- --confirm`, which runs it in one transaction and supplies the timestamp
-- drizzle recorded for migration 0006. Mission worktrees on disk (<data>/engineering) aren't touched; local branches
-- KELQOR created (kelqor/eng/e-NNNN) stay in their repositories.
-- Later milestones' tables first (M4's 0007), since every migration record from this one on is removed.
DROP TABLE IF EXISTS "invoice_lines", "invoices", "service_events", "service_requests", "customer_services" CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_freeze"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_lines_freeze"() CASCADE;
DROP TABLE IF EXISTS "eng_events", "eng_missions", "eng_workspaces" CASCADE;
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" >= :m3_since;
