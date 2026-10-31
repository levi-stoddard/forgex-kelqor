CREATE TABLE "opportunity_decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"record_id" text NOT NULL,
	"company_name" text NOT NULL,
	"decision" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"decided_by_id" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_decisions" ADD CONSTRAINT "opportunity_decisions_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_decisions_record_idx" ON "opportunity_decisions" USING btree ("source","record_id");