CREATE TABLE "eng_events" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"actor_id" text,
	"summary" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"number" serial NOT NULL,
	"title" text NOT NULL,
	"task" text NOT NULL,
	"deliverables" text DEFAULT '' NOT NULL,
	"workspace_id" text NOT NULL,
	"agent" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"change_state" text DEFAULT 'none' NOT NULL,
	"scope_fingerprint" text NOT NULL,
	"state_reason" text,
	"activity" text,
	"approved_by_id" text,
	"approved_at" timestamp with time zone,
	"approved_fingerprint" text,
	"base_commit" text,
	"worktree_path" text,
	"run_id" text,
	"deliverable" jsonb,
	"applied_branch" text,
	"applied_commit" text,
	"cost_micros" integer,
	"cost_source" text DEFAULT 'none' NOT NULL,
	"created_by_id" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eng_workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"base_branch" text NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "eng_events" ADD CONSTRAINT "eng_events_mission_id_eng_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."eng_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng_events" ADD CONSTRAINT "eng_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng_missions" ADD CONSTRAINT "eng_missions_workspace_id_eng_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."eng_workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng_missions" ADD CONSTRAINT "eng_missions_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng_missions" ADD CONSTRAINT "eng_missions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eng_workspaces" ADD CONSTRAINT "eng_workspaces_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "eng_events_mission_idx" ON "eng_events" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "eng_events_request_idx" ON "eng_events" USING btree ("mission_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eng_missions_number_idx" ON "eng_missions" USING btree ("number");--> statement-breakpoint
CREATE INDEX "eng_missions_status_idx" ON "eng_missions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "eng_workspaces_path_idx" ON "eng_workspaces" USING btree ("path");