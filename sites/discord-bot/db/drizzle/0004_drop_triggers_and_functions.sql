-- Hand-written: drizzle-kit cannot generate a DROP of triggers and functions it does not
-- know. The bot does in TypeScript everything these did (src/db/history.ts and rules.ts),
-- and has since the previous release, so nothing here changes what a write does.
-- Fail fast rather than queue behind live bot writes while holding a table lock.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint

-- The bot only reads row_versions to skip a version a trigger already kept; with no
-- triggers it has no reason to.
REVOKE SELECT (xid, source_table, row_id, old_row) ON TABLE discord_bot.row_versions FROM bot_app;--> statement-breakpoint

-- The 22 triggers.
DROP TRIGGER IF EXISTS event_step_assignees_record_update ON discord_bot.event_step_assignees;--> statement-breakpoint
DROP TRIGGER IF EXISTS event_steps_record_update ON discord_bot.event_steps;--> statement-breakpoint
DROP TRIGGER IF EXISTS event_steps_set_updated_at ON discord_bot.event_steps;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_create_steps ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_record_update ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_refuse_reopen ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_refuse_undelete ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_require_open_parent ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS events_set_updated_at ON discord_bot.events;--> statement-breakpoint
DROP TRIGGER IF EXISTS guild_config_check_timezone ON discord_bot.guild_config;--> statement-breakpoint
DROP TRIGGER IF EXISTS guild_config_record_update ON discord_bot.guild_config;--> statement-breakpoint
DROP TRIGGER IF EXISTS guild_config_set_updated_at ON discord_bot.guild_config;--> statement-breakpoint
DROP TRIGGER IF EXISTS managed_channels_record_update ON discord_bot.managed_channels;--> statement-breakpoint
DROP TRIGGER IF EXISTS managed_channels_set_updated_at ON discord_bot.managed_channels;--> statement-breakpoint
DROP TRIGGER IF EXISTS setup_drafts_record_update ON discord_bot.setup_drafts;--> statement-breakpoint
DROP TRIGGER IF EXISTS task_reassignments_require_quota ON discord_bot.task_reassignments;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_record_update ON discord_bot.tasks;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_refuse_undelete ON discord_bot.tasks;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_require_open_parent ON discord_bot.tasks;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_require_open_parent_on_update ON discord_bot.tasks;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_require_quota ON discord_bot.tasks;--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_set_updated_at ON discord_bot.tasks;--> statement-breakpoint

-- The nine trigger functions and the 34 older ones a database built before the baseline still
-- holds. Dropped by name, in whatever form they exist; no CASCADE, so anything that still
-- depends on one stops the migration instead of being dropped with it.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p
     WHERE p.pronamespace = 'discord_bot'::regnamespace AND p.prokind = 'f' AND p.proname IN (
        'apply_config_change',
        'apply_role_bindings',
        'assign_event_step',
        'begin_job_run',
        'check_guild_timezone',
        'claim_event_post_attempt',
        'claim_event_reminder',
        'claim_interaction',
        'claim_reminder',
        'claim_step_handoff',
        'close_stale_event_reminder',
        'close_stale_reminder',
        'complete_event_step',
        'create_event_steps',
        'edit_task',
        'enforce_reassignment_quota',
        'enforce_task_quotas',
        'event_reminder_allowed',
        'event_reminder_day_open',
        'expire_interaction_claims',
        'finish_job_run',
        'mark_channel_unavailable',
        'mark_event_reminder_sent',
        'mark_event_reminder_skipped',
        'mark_reminder_sent',
        'mark_reminder_skipped',
        'mark_step_handoff_sent',
        'reclaim_event_reminder',
        'reclaim_reminder',
        'record_reminder_refused',
        'record_row_version',
        'refuse_reopen',
        'refuse_undelete',
        'release_event_post_attempt',
        'reopen_event_step',
        'require_open_parent',
        'save_setup_draft',
        'set_event_pickup_time',
        'set_slides_not_needed',
        'set_updated_at',
        'soft_delete_event',
        'sync_food_pickup_step',
        'unassign_event_step'
     )
  LOOP
    EXECUTE format('DROP FUNCTION %s', item.signature);
  END LOOP;
END $$;
