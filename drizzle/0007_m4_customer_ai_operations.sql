CREATE TABLE "customer_services" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"category" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"plan_key" text NOT NULL,
	"monthly_cents" integer NOT NULL,
	"included_requests" integer NOT NULL,
	"overage_cents" integer NOT NULL,
	"setup_cents" integer DEFAULT 0 NOT NULL,
	"agreement_started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_services_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"service_id" text,
	"kind" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cents" integer NOT NULL,
	"amount_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"org_id" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"issued_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"replaces_invoice_id" text,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_org_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "invoices_simulated_only" CHECK ("invoices"."simulated" = true)
);
--> statement-breakpoint
CREATE TABLE "service_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"service_id" text,
	"request_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"customer_visible" boolean DEFAULT true NOT NULL,
	"actor_id" text,
	"request_key" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"org_id" text NOT NULL,
	"service_id" text NOT NULL,
	"title" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"processing" jsonb,
	"draft" jsonb,
	"draft_hash" text,
	"deliverable" jsonb,
	"review_note" text,
	"review_minutes" integer,
	"reviewed_by_id" text,
	"reviewed_at" timestamp with time zone,
	"needs_customer_approval" boolean DEFAULT false NOT NULL,
	"customer_note" text,
	"customer_decided_by_id" text,
	"customer_decided_at" timestamp with time zone,
	"ai_cost_micros" integer DEFAULT 0 NOT NULL,
	"cost_source" text DEFAULT 'simulated' NOT NULL,
	"state_reason" text,
	"submitted_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "service_requests_org_id_key" UNIQUE("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "customer_services" ADD CONSTRAINT "customer_services_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_services" ADD CONSTRAINT "customer_services_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_service_id_customer_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."customer_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_same_org_invoice_fk" FOREIGN KEY ("org_id","invoice_id") REFERENCES "public"."invoices"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_same_org_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."customer_services"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_replaces_same_org_fk" FOREIGN KEY ("org_id","replaces_invoice_id") REFERENCES "public"."invoices"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_service_id_customer_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."customer_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_request_id_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_same_org_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."customer_services"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_events" ADD CONSTRAINT "service_events_same_org_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."service_requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_service_id_customer_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."customer_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customer_decided_by_id_users_id_fk" FOREIGN KEY ("customer_decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_same_org_service_fk" FOREIGN KEY ("org_id","service_id") REFERENCES "public"."customer_services"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_services_org_idx" ON "customer_services" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_idx" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_period_idx" ON "invoices" USING btree ("org_id","period") WHERE "invoices"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "service_events_org_idx" ON "service_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_events_key_idx" ON "service_events" USING btree ("org_id","request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "service_requests_number_idx" ON "service_requests" USING btree ("number");--> statement-breakpoint
CREATE INDEX "service_requests_org_idx" ON "service_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "service_requests_service_idx" ON "service_requests" USING btree ("service_id");