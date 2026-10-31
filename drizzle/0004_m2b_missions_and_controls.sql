CREATE TABLE "ai_usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"mission_id" text,
	"approval_id" text,
	"step_id" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"purpose" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"price_version" text NOT NULL,
	"prices" jsonb NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"boise_day" text NOT NULL,
	"boise_month" text NOT NULL,
	"counted_input_tokens" integer NOT NULL,
	"reserved_input_tokens" integer NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"reserved_micros" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"usage" jsonb,
	"actual_micros" integer,
	"over_reservation" boolean DEFAULT false NOT NULL,
	"provider_request_id" text,
	"error_kind" text,
	"error_detail" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"released_micros" integer DEFAULT 0 NOT NULL,
	"committed_micros" integer GENERATED ALWAYS AS (case status when 'reserved' then reserved_micros when 'settled' then actual_micros when 'unverified' then reserved_micros - released_micros else 0 end) STORED,
	"backend_instance" text NOT NULL,
	"settled_at" timestamp with time zone,
	"reconciliation_id" text,
	"provider_review_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_figures" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"call_id" text NOT NULL,
	"statement" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"period" text NOT NULL,
	"basis" text DEFAULT '' NOT NULL,
	"validated_cents" integer,
	"calculation" text,
	"evidence" text,
	"validated_by_id" text,
	"validated_at" timestamp with time zone,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "industry_intelligence" (
	"id" text PRIMARY KEY NOT NULL,
	"series_key" text NOT NULL,
	"version" integer NOT NULL,
	"industry" text NOT NULL,
	"category" text,
	"region" text,
	"mission_id" text NOT NULL,
	"protocol" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"report" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"cost_micros" integer NOT NULL,
	"with_issues" boolean DEFAULT false NOT NULL,
	"mission_simulated" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "industry_intelligence_not_simulated" CHECK (not "industry_intelligence"."mission_simulated")
);
--> statement-breakpoint
CREATE TABLE "mission_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"kind" text NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"max_cost_micros" integer NOT NULL,
	"review" jsonb,
	"approved_by_id" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"boise_day" text NOT NULL,
	"authority_granted_at" timestamp with time zone NOT NULL,
	"request_id" text NOT NULL,
	"voided_at" timestamp with time zone,
	"void_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" serial NOT NULL,
	"mission_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"actor_id" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"subject" jsonb NOT NULL,
	"title" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"protocol" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"thinking_level" text NOT NULL,
	"max_output_tokens" integer NOT NULL,
	"max_cost_micros" integer NOT NULL,
	"review" jsonb,
	"scope_fingerprint" text NOT NULL,
	"state_reason" text,
	"run_id" text,
	"working_state" jsonb,
	"result" jsonb,
	"created_by_id" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_id_simulated_key" UNIQUE("id","simulated")
);
--> statement-breakpoint
CREATE TABLE "research_records" (
	"id" text PRIMARY KEY NOT NULL,
	"company_key" text NOT NULL,
	"version" integer NOT NULL,
	"company_name" text NOT NULL,
	"website" text NOT NULL,
	"town" text DEFAULT '' NOT NULL,
	"state" text DEFAULT '' NOT NULL,
	"industry" text,
	"mission_id" text NOT NULL,
	"protocol" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"report" jsonb NOT NULL,
	"checks" jsonb NOT NULL,
	"sources" jsonb NOT NULL,
	"cost_micros" integer NOT NULL,
	"with_issues" boolean DEFAULT false NOT NULL,
	"mission_simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_records_not_simulated" CHECK (not "research_records"."mission_simulated")
);
--> statement-breakpoint
CREATE TABLE "research_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"name" text NOT NULL,
	"match" text NOT NULL,
	"kind" text NOT NULL,
	"industries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"origin" text NOT NULL,
	"mission_id" text,
	"note" text DEFAULT '' NOT NULL,
	"changed_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spending_reconciliations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"period_kind" text,
	"period" text,
	"provider_micros" integer,
	"settled_micros" integer DEFAULT 0 NOT NULL,
	"unverified_micros" integer DEFAULT 0 NOT NULL,
	"released_micros" integer DEFAULT 0 NOT NULL,
	"adjustment_micros" integer DEFAULT 0 NOT NULL,
	"figure_id" text,
	"entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text NOT NULL,
	"recorded_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "spending_authority_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sign_in_disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_approval_id_mission_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."mission_approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_step_id_mission_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."mission_steps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_reconciliation_id_spending_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."spending_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_ledger" ADD CONSTRAINT "ai_usage_ledger_provider_review_id_spending_reconciliations_id_fk" FOREIGN KEY ("provider_review_id") REFERENCES "public"."spending_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_figures" ADD CONSTRAINT "discovery_figures_call_id_discovery_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."discovery_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_figures" ADD CONSTRAINT "discovery_figures_validated_by_id_users_id_fk" FOREIGN KEY ("validated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_figures" ADD CONSTRAINT "discovery_figures_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industry_intelligence" ADD CONSTRAINT "industry_intelligence_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industry_intelligence" ADD CONSTRAINT "industry_intelligence_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "industry_intelligence" ADD CONSTRAINT "industry_intelligence_real_mission_fk" FOREIGN KEY ("mission_id","mission_simulated") REFERENCES "public"."missions"("id","simulated") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_approvals" ADD CONSTRAINT "mission_approvals_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_steps" ADD CONSTRAINT "mission_steps_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_steps" ADD CONSTRAINT "mission_steps_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_records" ADD CONSTRAINT "research_records_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_records" ADD CONSTRAINT "research_records_real_mission_fk" FOREIGN KEY ("mission_id","mission_simulated") REFERENCES "public"."missions"("id","simulated") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_sources" ADD CONSTRAINT "research_sources_changed_by_id_users_id_fk" FOREIGN KEY ("changed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_figure_id_spending_reconciliations_id_fk" FOREIGN KEY ("figure_id") REFERENCES "public"."spending_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_reconciliations" ADD CONSTRAINT "spending_reconciliations_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_ledger_seq_idx" ON "ai_usage_ledger" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_mission_idx" ON "ai_usage_ledger" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_day_idx" ON "ai_usage_ledger" USING btree ("boise_day");--> statement-breakpoint
CREATE INDEX "ai_usage_ledger_month_idx" ON "ai_usage_ledger" USING btree ("boise_month");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_ledger_step_idx" ON "ai_usage_ledger" USING btree ("step_id","attempt","purpose");--> statement-breakpoint
CREATE INDEX "discovery_figures_record_idx" ON "discovery_figures" USING btree ("source","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "industry_intelligence_version_idx" ON "industry_intelligence" USING btree ("series_key","version");--> statement-breakpoint
CREATE INDEX "mission_approvals_mission_idx" ON "mission_approvals" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_approvals_request_idx" ON "mission_approvals" USING btree ("mission_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_approvals_open_idx" ON "mission_approvals" USING btree ("mission_id","kind") WHERE "mission_approvals"."voided_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mission_steps_seq_idx" ON "mission_steps" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "mission_steps_mission_idx" ON "mission_steps" USING btree ("mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mission_steps_request_idx" ON "mission_steps" USING btree ("mission_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missions_number_idx" ON "missions" USING btree ("number");--> statement-breakpoint
CREATE INDEX "missions_status_idx" ON "missions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "research_records_version_idx" ON "research_records" USING btree ("company_key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "research_sources_version_idx" ON "research_sources" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "spending_reconciliations_period_idx" ON "spending_reconciliations" USING btree ("provider","period");--> statement-breakpoint
CREATE UNIQUE INDEX "users_one_spending_authority_idx" ON "users" USING btree (("spending_authority_at" is not null)) WHERE "users"."spending_authority_at" is not null;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_spending_authority_check" CHECK ("users"."spending_authority_at" is null or ("users"."role" = 'operator' and "users"."is_demo" = false and "users"."sign_in_disabled_at" is null));--> statement-breakpoint
-- Milestone 2B: password sign-in is turned off for every seeded demo account. Their records stay; dropping the
-- sign_in_disabled_at column (see docs/m2b/ROLLBACK.md) turns it back on.
UPDATE "users" SET "sign_in_disabled_at" = now() WHERE "is_demo" = true AND "sign_in_disabled_at" IS NULL;
