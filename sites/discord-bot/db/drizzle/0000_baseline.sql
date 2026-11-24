-- The schema is made by the operator before the first migration, as docs/SETUP.md says,
-- so the migration tool can keep its ledger in it. IF NOT EXISTS keeps this file whole.
CREATE SCHEMA IF NOT EXISTS "discord_bot";
--> statement-breakpoint
-- Drizzle has no domain, so the one every Discord ID column uses is made by hand.
CREATE DOMAIN "discord_bot"."discord_id" AS text
	CONSTRAINT "discord_id_check" CHECK ((VALUE ~ '^[0-9]{17,20}$'::text));
--> statement-breakpoint
CREATE TYPE "discord_bot"."event_reminder_kind" AS ENUM('daily_steps', 'pickup_before', 'pickup_day', 'steps_unassigned', 'budget_due', 'engage_due', 'budget_overdue', 'engage_overdue', 'engage_picture_late', 'marketing_week', 'slides_unassigned', 'pickup_unset', 'marketing_saturday', 'slides_due', 'slides_tomorrow', 'event_today');--> statement-breakpoint
CREATE TYPE "discord_bot"."event_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TYPE "discord_bot"."event_step_kind" AS ENUM('budget_sheet', 'engage_post', 'engage_picture', 'budget_approved', 'slides', 'food_pickup');--> statement-breakpoint
CREATE TYPE "discord_bot"."job_run_status" AS ENUM('running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "discord_bot"."managed_channel_status" AS ENUM('active', 'unavailable', 'removed');--> statement-breakpoint
CREATE TYPE "discord_bot"."reminder_kind" AS ENUM('three_days', 'one_day', 'due_day', 'overdue');--> statement-breakpoint
CREATE TYPE "discord_bot"."reminder_state" AS ENUM('claimed', 'sent', 'skipped');--> statement-breakpoint
CREATE TYPE "discord_bot"."task_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TYPE "discord_bot"."thread_status" AS ENUM('pending', 'active', 'missing');--> statement-breakpoint
CREATE TABLE "discord_bot"."config_audit" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "discord_bot"."config_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"actor_id" "discord_bot"."discord_id" NOT NULL,
	"action" text NOT NULL,
	"old_values" jsonb,
	"new_values" jsonb NOT NULL,
	"version_after" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "config_audit_pkey" PRIMARY KEY("id"),
	CONSTRAINT "config_audit_action_known" CHECK ("discord_bot"."config_audit"."action" = ANY (ARRAY['role_bindings'::text, 'settings'::text]))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."event_reminder_log" (
	"event_id" uuid NOT NULL,
	"kind" "discord_bot"."event_reminder_kind" NOT NULL,
	"reminder_date" date NOT NULL,
	"state" "discord_bot"."reminder_state" DEFAULT 'claimed' NOT NULL,
	"claim_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"message_id" "discord_bot"."discord_id",
	CONSTRAINT "event_reminder_log_pkey" PRIMARY KEY("event_id","kind","reminder_date"),
	CONSTRAINT "event_reminder_log_attempts_positive" CHECK ("discord_bot"."event_reminder_log"."attempts" >= 1),
	CONSTRAINT "event_reminder_log_date_range" CHECK ("discord_bot"."event_reminder_log"."reminder_date" >= '2000-01-01'::date AND "discord_bot"."event_reminder_log"."reminder_date" <= '9999-12-31'::date),
	CONSTRAINT "event_reminder_log_message_only_when_sent" CHECK ("discord_bot"."event_reminder_log"."message_id" IS NULL OR "discord_bot"."event_reminder_log"."state" = 'sent'::discord_bot.reminder_state),
	CONSTRAINT "event_reminder_log_sent_at_matches_state" CHECK (("discord_bot"."event_reminder_log"."sent_at" IS NOT NULL) = ("discord_bot"."event_reminder_log"."state" = 'sent'::discord_bot.reminder_state))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."event_step_assignees" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"kind" "discord_bot"."event_step_kind" NOT NULL,
	"user_id" "discord_bot"."discord_id" NOT NULL,
	"assigned_by" "discord_bot"."discord_id" NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" "discord_bot"."discord_id",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_step_assignees_pkey" PRIMARY KEY("id"),
	CONSTRAINT "event_step_assignees_kind_assignable" CHECK ("discord_bot"."event_step_assignees"."kind" <> ALL (ARRAY['budget_approved', 'engage_picture']::discord_bot.event_step_kind[])),
	CONSTRAINT "event_step_assignees_removed_together" CHECK (("discord_bot"."event_step_assignees"."removed_at" IS NULL) = ("discord_bot"."event_step_assignees"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."event_steps" (
	"event_id" uuid NOT NULL,
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"kind" "discord_bot"."event_step_kind" NOT NULL,
	"status" "discord_bot"."task_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" "discord_bot"."discord_id",
	"handoff_claimed_at" timestamp with time zone,
	"handoff_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_needed_at" timestamp with time zone,
	"not_needed_by" "discord_bot"."discord_id",
	CONSTRAINT "event_steps_pkey" PRIMARY KEY("event_id","kind"),
	CONSTRAINT "event_steps_completed_by_matches_status" CHECK (("discord_bot"."event_steps"."completed_by" IS NOT NULL) = ("discord_bot"."event_steps"."status" = 'done'::discord_bot.task_status)),
	CONSTRAINT "event_steps_completed_matches_status" CHECK (("discord_bot"."event_steps"."completed_at" IS NOT NULL) = ("discord_bot"."event_steps"."status" = 'done'::discord_bot.task_status)),
	CONSTRAINT "event_steps_handoff_only_when_done" CHECK ("discord_bot"."event_steps"."handoff_claimed_at" IS NULL OR ("discord_bot"."event_steps"."status" = 'done'::discord_bot.task_status AND "discord_bot"."event_steps"."kind" <> 'food_pickup'::discord_bot.event_step_kind)),
	CONSTRAINT "event_steps_handoff_sent_after_claim" CHECK ("discord_bot"."event_steps"."handoff_sent_at" IS NULL OR "discord_bot"."event_steps"."handoff_claimed_at" IS NOT NULL),
	CONSTRAINT "event_steps_not_needed_together" CHECK (("discord_bot"."event_steps"."not_needed_at" IS NULL) = ("discord_bot"."event_steps"."not_needed_by" IS NULL)),
	CONSTRAINT "event_steps_not_needed_only_open_slides" CHECK ("discord_bot"."event_steps"."not_needed_at" IS NULL OR ("discord_bot"."event_steps"."kind" = 'slides'::discord_bot.event_step_kind AND "discord_bot"."event_steps"."status" = 'open'::discord_bot.task_status))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."events" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"channel_id" "discord_bot"."discord_id" NOT NULL,
	"name" text NOT NULL,
	"event_date" date NOT NULL,
	"thread_id" "discord_bot"."discord_id",
	"overview_message_id" "discord_bot"."discord_id",
	"status" "discord_bot"."event_status" DEFAULT 'active' NOT NULL,
	"thread_status" "discord_bot"."thread_status" DEFAULT 'pending' NOT NULL,
	"created_by" "discord_bot"."discord_id" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"post_attempt_at" timestamp with time zone,
	"pickup_time" time,
	CONSTRAINT "events_pkey" PRIMARY KEY("id"),
	CONSTRAINT "events_id_guild_unique" UNIQUE("id","guild_id"),
	CONSTRAINT "events_event_date_range" CHECK ("discord_bot"."events"."event_date" >= '2000-01-01'::date AND "discord_bot"."events"."event_date" <= '9999-12-31'::date),
	CONSTRAINT "events_name_length" CHECK (char_length("discord_bot"."events"."name") >= 1),
	CONSTRAINT "events_thread_matches_status" CHECK (("discord_bot"."events"."thread_id" IS NULL) = ("discord_bot"."events"."thread_status" = 'pending'::discord_bot.thread_status))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."guild_config" (
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"officer_role_id" "discord_bot"."discord_id" NOT NULL,
	"admin_role_id" "discord_bot"."discord_id" NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"reminders_enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"eboard_role_id" "discord_bot"."discord_id",
	"events_committee_role_id" "discord_bot"."discord_id",
	"treasury_role_id" "discord_bot"."discord_id",
	"marketing_role_id" "discord_bot"."discord_id",
	CONSTRAINT "guild_config_pkey" PRIMARY KEY("guild_id"),
	CONSTRAINT "guild_config_admin_not_everyone" CHECK (("discord_bot"."guild_config"."admin_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_eboard_not_everyone" CHECK (("discord_bot"."guild_config"."eboard_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_events_committee_not_everyone" CHECK (("discord_bot"."guild_config"."events_committee_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_marketing_not_everyone" CHECK (("discord_bot"."guild_config"."marketing_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_officer_not_everyone" CHECK (("discord_bot"."guild_config"."officer_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_treasury_not_everyone" CHECK (("discord_bot"."guild_config"."treasury_role_id")::text <> ("discord_bot"."guild_config"."guild_id")::text),
	CONSTRAINT "guild_config_version_positive" CHECK ("discord_bot"."guild_config"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."interaction_claims" (
	"interaction_id" "discord_bot"."discord_id" NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_claims_pkey" PRIMARY KEY("interaction_id")
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."job_runs" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"status" "discord_bot"."job_run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	CONSTRAINT "job_runs_pkey" PRIMARY KEY("id"),
	CONSTRAINT "job_runs_error_size" CHECK (char_length("discord_bot"."job_runs"."error") <= 4000),
	CONSTRAINT "job_runs_finished_matches_status" CHECK (("discord_bot"."job_runs"."finished_at" IS NULL) = ("discord_bot"."job_runs"."status" = 'running'::discord_bot.job_run_status)),
	CONSTRAINT "job_runs_job_name_length" CHECK (char_length("discord_bot"."job_runs"."job_name") >= 1 AND char_length("discord_bot"."job_runs"."job_name") <= 64),
	CONSTRAINT "job_runs_results_size" CHECK (char_length(("discord_bot"."job_runs"."results")::text) <= 16000)
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."managed_channels" (
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"channel_id" "discord_bot"."discord_id" NOT NULL,
	"status" "discord_bot"."managed_channel_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_channels_pkey" PRIMARY KEY("guild_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."reminder_log" (
	"task_id" uuid NOT NULL,
	"kind" "discord_bot"."reminder_kind" NOT NULL,
	"due_date" date NOT NULL,
	"state" "discord_bot"."reminder_state" DEFAULT 'claimed' NOT NULL,
	"claim_token" uuid DEFAULT gen_random_uuid() NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"message_id" "discord_bot"."discord_id",
	"refused_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "reminder_log_pkey" PRIMARY KEY("task_id","kind","due_date"),
	CONSTRAINT "reminder_log_attempts_positive" CHECK ("discord_bot"."reminder_log"."attempts" >= 1),
	CONSTRAINT "reminder_log_due_date_range" CHECK ("discord_bot"."reminder_log"."due_date" >= '2000-01-01'::date AND "discord_bot"."reminder_log"."due_date" <= '9999-12-31'::date),
	CONSTRAINT "reminder_log_message_only_when_sent" CHECK ("discord_bot"."reminder_log"."message_id" IS NULL OR "discord_bot"."reminder_log"."state" = 'sent'::discord_bot.reminder_state),
	CONSTRAINT "reminder_log_refused_attempts_range" CHECK ("discord_bot"."reminder_log"."refused_attempts" >= 0 AND "discord_bot"."reminder_log"."refused_attempts" <= "discord_bot"."reminder_log"."attempts"),
	CONSTRAINT "reminder_log_sent_at_matches_state" CHECK (("discord_bot"."reminder_log"."sent_at" IS NOT NULL) = ("discord_bot"."reminder_log"."state" = 'sent'::discord_bot.reminder_state))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."row_versions" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "discord_bot"."row_versions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source_table" text NOT NULL,
	"operation" text NOT NULL,
	"row_id" text NOT NULL,
	"old_row" jsonb NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "row_versions_pkey" PRIMARY KEY("id"),
	CONSTRAINT "row_versions_operation_known" CHECK ("discord_bot"."row_versions"."operation" = ANY (ARRAY['UPDATE'::text, 'DELETE'::text]))
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."setup_drafts" (
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"actor_id" "discord_bot"."discord_id" NOT NULL,
	"officer_role_id" "discord_bot"."discord_id" NOT NULL,
	"admin_role_id" "discord_bot"."discord_id" NOT NULL,
	"eboard_role_id" "discord_bot"."discord_id" NOT NULL,
	"events_committee_role_id" "discord_bot"."discord_id" NOT NULL,
	"treasury_role_id" "discord_bot"."discord_id" NOT NULL,
	"marketing_role_id" "discord_bot"."discord_id" NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "setup_drafts_pkey" PRIMARY KEY("guild_id"),
	CONSTRAINT "setup_drafts_admin_not_everyone" CHECK (("discord_bot"."setup_drafts"."admin_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text),
	CONSTRAINT "setup_drafts_eboard_not_everyone" CHECK (("discord_bot"."setup_drafts"."eboard_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text),
	CONSTRAINT "setup_drafts_events_committee_not_everyone" CHECK (("discord_bot"."setup_drafts"."events_committee_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text),
	CONSTRAINT "setup_drafts_fingerprint_shape" CHECK ("discord_bot"."setup_drafts"."fingerprint" ~ '^[A-Za-z0-9_-]{8,64}$'::text),
	CONSTRAINT "setup_drafts_marketing_not_everyone" CHECK (("discord_bot"."setup_drafts"."marketing_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text),
	CONSTRAINT "setup_drafts_officer_not_everyone" CHECK (("discord_bot"."setup_drafts"."officer_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text),
	CONSTRAINT "setup_drafts_treasury_not_everyone" CHECK (("discord_bot"."setup_drafts"."treasury_role_id")::text <> ("discord_bot"."setup_drafts"."guild_id")::text)
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."task_reassignments" (
	"id" bigint GENERATED ALWAYS AS IDENTITY (sequence name "discord_bot"."task_reassignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"actor_id" "discord_bot"."discord_id" NOT NULL,
	"task_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_reassignments_pkey" PRIMARY KEY("id")
);
--> statement-breakpoint
CREATE TABLE "discord_bot"."tasks" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"guild_id" "discord_bot"."discord_id" NOT NULL,
	"assignee_id" "discord_bot"."discord_id" NOT NULL,
	"description" text NOT NULL,
	"due_date" date NOT NULL,
	"status" "discord_bot"."task_status" DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" "discord_bot"."discord_id" NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_pkey" PRIMARY KEY("id"),
	CONSTRAINT "tasks_completed_matches_status" CHECK (("discord_bot"."tasks"."completed_at" IS NOT NULL) = ("discord_bot"."tasks"."status" = 'done'::discord_bot.task_status)),
	CONSTRAINT "tasks_description_length" CHECK (char_length("discord_bot"."tasks"."description") >= 1),
	CONSTRAINT "tasks_due_date_range" CHECK ("discord_bot"."tasks"."due_date" >= '2000-01-01'::date AND "discord_bot"."tasks"."due_date" <= '9999-12-31'::date)
);
--> statement-breakpoint
ALTER TABLE "discord_bot"."config_audit" ADD CONSTRAINT "config_audit_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "discord_bot"."guild_config"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."event_reminder_log" ADD CONSTRAINT "event_reminder_log_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "discord_bot"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."event_step_assignees" ADD CONSTRAINT "event_step_assignees_event_id_guild_id_fkey" FOREIGN KEY ("event_id","guild_id") REFERENCES "discord_bot"."events"("id","guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."event_steps" ADD CONSTRAINT "event_steps_event_id_guild_id_fkey" FOREIGN KEY ("event_id","guild_id") REFERENCES "discord_bot"."events"("id","guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."events" ADD CONSTRAINT "events_guild_id_channel_id_fkey" FOREIGN KEY ("guild_id","channel_id") REFERENCES "discord_bot"."managed_channels"("guild_id","channel_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."managed_channels" ADD CONSTRAINT "managed_channels_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "discord_bot"."guild_config"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."reminder_log" ADD CONSTRAINT "reminder_log_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "discord_bot"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."task_reassignments" ADD CONSTRAINT "task_reassignments_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "discord_bot"."guild_config"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."task_reassignments" ADD CONSTRAINT "task_reassignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "discord_bot"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_bot"."tasks" ADD CONSTRAINT "tasks_event_id_guild_id_fkey" FOREIGN KEY ("event_id","guild_id") REFERENCES "discord_bot"."events"("id","guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "config_audit_guild_idx" ON "discord_bot"."config_audit" USING btree ("guild_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "event_reminder_log_open_claims_idx" ON "discord_bot"."event_reminder_log" USING btree ("claimed_at") WHERE "discord_bot"."event_reminder_log"."state" = 'claimed'::discord_bot.reminder_state;--> statement-breakpoint
CREATE INDEX "event_step_assignees_by_user_idx" ON "discord_bot"."event_step_assignees" USING btree ("guild_id","user_id") WHERE "discord_bot"."event_step_assignees"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "event_step_assignees_live_uq" ON "discord_bot"."event_step_assignees" USING btree ("event_id","kind","user_id") WHERE "discord_bot"."event_step_assignees"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "events_channel_idx" ON "discord_bot"."events" USING btree ("guild_id","channel_id");--> statement-breakpoint
CREATE INDEX "events_by_thread_idx" ON "discord_bot"."events" USING btree ("guild_id","thread_id") WHERE "discord_bot"."events"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_open_by_date_idx" ON "discord_bot"."events" USING btree ("status","event_date") WHERE "discord_bot"."events"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "events_live_by_date_idx" ON "discord_bot"."events" USING btree ("guild_id","event_date") WHERE "discord_bot"."events"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_live_thread_uq" ON "discord_bot"."events" USING btree ("thread_id") WHERE "discord_bot"."events"."deleted_at" IS NULL AND "discord_bot"."events"."thread_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "events_one_pending_create_uq" ON "discord_bot"."events" USING btree ("guild_id","channel_id","created_by","name","event_date") WHERE "discord_bot"."events"."deleted_at" IS NULL AND "discord_bot"."events"."thread_status" = 'pending'::discord_bot.thread_status;--> statement-breakpoint
CREATE INDEX "job_runs_latest_idx" ON "discord_bot"."job_runs" USING btree ("job_name","started_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_one_running_idx" ON "discord_bot"."job_runs" USING btree ("job_name") WHERE "discord_bot"."job_runs"."status" = 'running'::discord_bot.job_run_status;--> statement-breakpoint
CREATE INDEX "reminder_log_open_claims_idx" ON "discord_bot"."reminder_log" USING btree ("claimed_at") WHERE "discord_bot"."reminder_log"."state" = 'claimed'::discord_bot.reminder_state;--> statement-breakpoint
CREATE INDEX "row_versions_lookup_idx" ON "discord_bot"."row_versions" USING btree ("source_table","row_id","id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "task_reassignments_by_actor_idx" ON "discord_bot"."task_reassignments" USING btree ("guild_id","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_by_creator_idx" ON "discord_bot"."tasks" USING btree ("guild_id","created_by","created_at");--> statement-breakpoint
CREATE INDEX "tasks_event_idx" ON "discord_bot"."tasks" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "tasks_open_by_assignee_idx" ON "discord_bot"."tasks" USING btree ("guild_id","assignee_id","due_date") WHERE "discord_bot"."tasks"."status" = 'open'::discord_bot.task_status AND "discord_bot"."tasks"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tasks_open_by_due_date_idx" ON "discord_bot"."tasks" USING btree ("due_date","guild_id") WHERE "discord_bot"."tasks"."status" = 'open'::discord_bot.task_status AND "discord_bot"."tasks"."deleted_at" IS NULL;