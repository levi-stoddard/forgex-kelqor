-- Undoes migrations 0007 and 0008 (Milestone 4, customer AI operations) in place, leaving M3, M2B and earlier as they are.
-- Run it with `npm run db:rollback-m4 -- --confirm`, which runs it in one transaction and supplies the timestamp drizzle
-- recorded for migration 0007. It deletes every customer service, request and invoice, issued ones included: the
-- script refuses while issued invoices exist unless a verified backup was made in the last hour. Customer organizations and their accounts (orgs, users) predate M4 and stay.
DROP TABLE IF EXISTS "invoice_lines", "invoices", "service_events", "service_requests", "customer_services" CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_freeze"() CASCADE;
DROP FUNCTION IF EXISTS "kelqor_invoice_lines_freeze"() CASCADE;
DELETE FROM "drizzle"."__drizzle_migrations" WHERE "created_at" >= :m4_since;
