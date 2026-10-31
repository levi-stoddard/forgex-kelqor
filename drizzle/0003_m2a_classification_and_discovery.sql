CREATE TABLE "discovery_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"held_on" text NOT NULL,
	"contact_name" text DEFAULT '' NOT NULL,
	"contact_role" text DEFAULT '' NOT NULL,
	"decision_maker" text DEFAULT 'unknown' NOT NULL,
	"software" text DEFAULT '' NOT NULL,
	"priorities" text DEFAULT '' NOT NULL,
	"desired_outcome" text DEFAULT '' NOT NULL,
	"value_to_them" text DEFAULT '' NOT NULL,
	"tried" text DEFAULT '' NOT NULL,
	"pain" integer,
	"next_step" text DEFAULT '' NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"recorded_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"statement" text NOT NULL,
	"source_url" text,
	"checked_on" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_problems" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"call_id" text NOT NULL,
	"finding_key" text,
	"statement" text NOT NULL,
	"status" text NOT NULL,
	"solution_rung" text,
	"solution" text DEFAULT '' NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"company_name" text NOT NULL,
	"industry" text,
	"work_order_id" text,
	"updated_by_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "data_class" text DEFAULT 'real' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "livemode" boolean;--> statement-breakpoint
ALTER TABLE "discovery_calls" ADD CONSTRAINT "discovery_calls_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_checks" ADD CONSTRAINT "opportunity_checks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_problems" ADD CONSTRAINT "opportunity_problems_call_id_discovery_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."discovery_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_problems" ADD CONSTRAINT "opportunity_problems_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_profiles" ADD CONSTRAINT "opportunity_profiles_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_profiles" ADD CONSTRAINT "opportunity_profiles_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "discovery_calls_record_idx" ON "discovery_calls" USING btree ("source","record_id");--> statement-breakpoint
CREATE INDEX "opportunity_checks_record_idx" ON "opportunity_checks" USING btree ("source","record_id");--> statement-breakpoint
CREATE INDEX "opportunity_problems_record_idx" ON "opportunity_problems" USING btree ("source","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_profiles_record_idx" ON "opportunity_profiles" USING btree ("source","record_id");--> statement-breakpoint
-- One-time classification of the companies that exist before this migration. From here on the class is explicit and
-- names are never read: seeded demo companies are demo, and the companies named "... (test)" during hand testing are test.
UPDATE "orgs" SET "data_class" = 'demo' WHERE "is_demo" = true;--> statement-breakpoint
UPDATE "orgs" SET "data_class" = 'test' WHERE "is_demo" = false AND "name" ILIKE '%(test)';
