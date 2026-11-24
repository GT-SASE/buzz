-- Everything Drizzle cannot say, written by hand: the trigger functions and triggers that
-- stay in the database as a backstop whatever code writes to it, the bot's login role,
-- and every grant. The tables, types, keys and indexes are in 0000_baseline.sql.
--
-- This file is safe to run twice, and safe to run on the production database, where
-- dbmate made all of this already: functions and triggers are made with CREATE OR
-- REPLACE, the role only if it is missing, and a grant that is already held changes
-- nothing. It revokes nothing that code already deployed uses, and it does not touch the
-- functions dbmate made for the old bot code, which a later change drops.
--
-- The triggers that remain:
--   record_row_version          the old version of every changed row, in row_versions
--   enforce_task_quotas         an event holds at most 100 tasks, an officer makes 50 a day
--   enforce_reassignment_quota  a reassignment counts against that daily limit
--   refuse_undelete             a soft-deleted row stays deleted
--   refuse_reopen               a closed event stays closed
--   create_event_steps          a new event gets its checklist
--   check_guild_timezone        a guild's time zone is one the server knows
--   require_open_parent         nothing is added under a removed channel or a closed event
--   set_updated_at              updated_at moves with the row

SET LOCAL check_function_bodies = off;
--> statement-breakpoint
-- The trigger names the row's key columns, in order.
CREATE OR REPLACE FUNCTION discord_bot.record_row_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO discord_bot.row_versions (source_table, operation, row_id, old_row)
  VALUES (
    TG_TABLE_NAME,
    TG_OP,
    (
      SELECT pg_catalog.string_agg(pg_catalog.to_jsonb(OLD) ->> key.name, ':' ORDER BY key.position)
      FROM pg_catalog.unnest(TG_ARGV) WITH ORDINALITY AS key (name, position)
    ),
    pg_catalog.to_jsonb(OLD)
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.check_guild_timezone() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.timezone = OLD.timezone THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown timezone' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.create_event_steps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO discord_bot.event_steps (event_id, guild_id, kind)
  SELECT NEW.id, NEW.guild_id, kind
  FROM unnest(enum_range(NULL::discord_bot.event_step_kind)) AS kind;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.enforce_reassignment_quota() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'task quotas need read committed' USING ERRCODE = '0A000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-actor:' || NEW.guild_id || ':' || NEW.actor_id, 0)
  );

  IF (
    SELECT count(*) FROM discord_bot.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM discord_bot.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.enforce_task_quotas() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'task quotas need read committed' USING ERRCODE = '0A000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-event:' || NEW.event_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-actor:' || NEW.guild_id || ':' || NEW.created_by, 0)
  );

  IF (
    SELECT count(*) FROM discord_bot.tasks
    WHERE event_id = NEW.event_id AND deleted_at IS NULL
  ) >= 100 THEN
    RAISE EXCEPTION 'event task limit reached' USING ERRCODE = 'CF429';
  END IF;

  IF (
    SELECT count(*) FROM discord_bot.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM discord_bot.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A soft-deleted task stays deleted. Bringing one back could revive it on a closed or
-- deleted event and past the event's task limit, which every other path checks. Only
-- the tables' owner may, by hand, as docs/RECOVERY.md describes.
CREATE OR REPLACE FUNCTION discord_bot.refuse_undelete() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL
    AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
    AND NOT pg_catalog.pg_has_role(
      current_user,
      (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = TG_RELID),
      'USAGE'
    )
  THEN
    RAISE EXCEPTION 'a deleted row stays deleted' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- A closed event stays closed. The bot tells people there is no way to reopen one, and
-- reopening would bring back reminders for its tasks. Only the tables' owner may, by
-- hand, as docs/RECOVERY.md describes.
CREATE OR REPLACE FUNCTION discord_bot.refuse_reopen() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF OLD.status = 'closed'
    AND NEW.status IS DISTINCT FROM OLD.status
    AND NOT pg_catalog.pg_has_role(
      current_user,
      (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = TG_RELID),
      'USAGE'
    )
  THEN
    RAISE EXCEPTION 'a closed event stays closed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.require_open_parent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_channel_status discord_bot.managed_channel_status;
  v_event_status discord_bot.event_status;
  v_event_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    SELECT status INTO v_channel_status
    FROM discord_bot.managed_channels
    WHERE guild_id = NEW.guild_id AND channel_id = NEW.channel_id
    FOR SHARE;

    IF v_channel_status = 'removed' THEN
      RAISE EXCEPTION 'channel has been removed' USING ERRCODE = 'CF410';
    END IF;
  ELSE
    SELECT status, deleted_at INTO v_event_status, v_event_deleted_at
    FROM discord_bot.events
    WHERE id = NEW.event_id AND guild_id = NEW.guild_id
    FOR SHARE;

    IF v_event_status = 'closed' OR v_event_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'event is closed or deleted' USING ERRCODE = 'CF410';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION discord_bot.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  discord_bot.record_row_version(),
  discord_bot.check_guild_timezone(),
  discord_bot.create_event_steps(),
  discord_bot.enforce_reassignment_quota(),
  discord_bot.enforce_task_quotas(),
  discord_bot.refuse_undelete(),
  discord_bot.refuse_reopen(),
  discord_bot.require_open_parent(),
  discord_bot.set_updated_at()
FROM PUBLIC;
--> statement-breakpoint
-- The triggers.
CREATE OR REPLACE TRIGGER event_step_assignees_record_update AFTER UPDATE ON discord_bot.event_step_assignees FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER event_steps_record_update AFTER UPDATE ON discord_bot.event_steps FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('event_id', 'kind');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER event_steps_set_updated_at BEFORE UPDATE ON discord_bot.event_steps FOR EACH ROW EXECUTE FUNCTION discord_bot.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_create_steps AFTER INSERT ON discord_bot.events FOR EACH ROW EXECUTE FUNCTION discord_bot.create_event_steps();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_record_update AFTER UPDATE ON discord_bot.events FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_refuse_reopen BEFORE UPDATE OF status ON discord_bot.events FOR EACH ROW EXECUTE FUNCTION discord_bot.refuse_reopen();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_refuse_undelete BEFORE UPDATE OF deleted_at ON discord_bot.events FOR EACH ROW EXECUTE FUNCTION discord_bot.refuse_undelete();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_require_open_parent BEFORE INSERT ON discord_bot.events FOR EACH ROW EXECUTE FUNCTION discord_bot.require_open_parent();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER events_set_updated_at BEFORE UPDATE ON discord_bot.events FOR EACH ROW EXECUTE FUNCTION discord_bot.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guild_config_record_update AFTER UPDATE ON discord_bot.guild_config FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('guild_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guild_config_check_timezone BEFORE INSERT OR UPDATE OF timezone ON discord_bot.guild_config FOR EACH ROW EXECUTE FUNCTION discord_bot.check_guild_timezone();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER guild_config_set_updated_at BEFORE UPDATE ON discord_bot.guild_config FOR EACH ROW EXECUTE FUNCTION discord_bot.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER managed_channels_record_update AFTER UPDATE ON discord_bot.managed_channels FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('guild_id', 'channel_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER setup_drafts_record_update AFTER UPDATE ON discord_bot.setup_drafts FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('guild_id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER managed_channels_set_updated_at BEFORE UPDATE ON discord_bot.managed_channels FOR EACH ROW EXECUTE FUNCTION discord_bot.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER task_reassignments_require_quota BEFORE INSERT ON discord_bot.task_reassignments FOR EACH ROW EXECUTE FUNCTION discord_bot.enforce_reassignment_quota();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_record_update AFTER UPDATE ON discord_bot.tasks FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION discord_bot.record_row_version('id');
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_refuse_undelete BEFORE UPDATE OF deleted_at ON discord_bot.tasks FOR EACH ROW EXECUTE FUNCTION discord_bot.refuse_undelete();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_require_open_parent BEFORE INSERT ON discord_bot.tasks FOR EACH ROW EXECUTE FUNCTION discord_bot.require_open_parent();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_require_open_parent_on_update BEFORE UPDATE OF assignee_id, description, due_date, status ON discord_bot.tasks FOR EACH ROW EXECUTE FUNCTION discord_bot.require_open_parent();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_require_quota BEFORE INSERT ON discord_bot.tasks FOR EACH ROW EXECUTE FUNCTION discord_bot.enforce_task_quotas();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER tasks_set_updated_at BEFORE UPDATE ON discord_bot.tasks FOR EACH ROW EXECUTE FUNCTION discord_bot.set_updated_at();
--> statement-breakpoint
-- A login with no password. The operator sets one once, out of band, with
-- ALTER ROLE bot_app PASSWORD, as docs/SETUP.md says, so no credential is ever in this
-- repository.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'bot_app') THEN
    CREATE ROLE bot_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
--> statement-breakpoint

-- A bound on anything the bot starts, whatever pooler is in front. These are defaults,
-- not a defence: a role may change its own settings.
ALTER ROLE bot_app SET statement_timeout = '10s';
--> statement-breakpoint

ALTER ROLE bot_app SET idle_in_transaction_session_timeout = '15s';
--> statement-breakpoint

-- The bot reads dates and times as UTC. A guild's own zone is applied by name where it
-- matters, never through the session's.
ALTER ROLE bot_app SET timezone = 'UTC';
--> statement-breakpoint
-- Nothing here is open to PUBLIC. New functions, tables, sequences and types start open
-- to PUBLIC by Postgres default (functions and types) or have to be checked (tables), so
-- later migrations that add objects must repeat these REVOKEs for them.
REVOKE ALL ON SCHEMA discord_bot FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON ALL TABLES IN SCHEMA discord_bot FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON ALL SEQUENCES IN SCHEMA discord_bot FROM PUBLIC;
--> statement-breakpoint

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA discord_bot FROM PUBLIC;
--> statement-breakpoint

REVOKE USAGE ON DOMAIN discord_bot.discord_id FROM PUBLIC;
--> statement-breakpoint

REVOKE USAGE ON TYPE
  discord_bot.event_reminder_kind,
  discord_bot.event_status,
  discord_bot.event_step_kind,
  discord_bot.job_run_status,
  discord_bot.managed_channel_status,
  discord_bot.reminder_kind,
  discord_bot.reminder_state,
  discord_bot.task_status,
  discord_bot.thread_status
FROM PUBLIC;
--> statement-breakpoint
-- bot_app writes the tables itself, in transactions that take the locks, check the
-- versions and claim the tokens in TypeScript (src/db). Each table gets what that code
-- does and no more: columns, where a write only ever changes some. Nothing is ever
-- deleted or truncated except interaction_claims, whose rows are only worth keeping for
-- a day. Rows elsewhere are soft-deleted, and row_versions, which the bot cannot read or
-- write, keeps the old version of every changed one.
GRANT USAGE ON SCHEMA discord_bot TO bot_app;
--> statement-breakpoint

GRANT USAGE ON DOMAIN discord_bot.discord_id TO bot_app;
--> statement-breakpoint

GRANT USAGE ON TYPE
  discord_bot.event_reminder_kind,
  discord_bot.event_status,
  discord_bot.event_step_kind,
  discord_bot.job_run_status,
  discord_bot.managed_channel_status,
  discord_bot.reminder_kind,
  discord_bot.reminder_state,
  discord_bot.task_status,
  discord_bot.thread_status
TO bot_app;
--> statement-breakpoint

GRANT SELECT ON TABLE
  discord_bot.config_audit,
  discord_bot.event_reminder_log,
  discord_bot.event_step_assignees,
  discord_bot.event_steps,
  discord_bot.events,
  discord_bot.guild_config,
  discord_bot.interaction_claims,
  discord_bot.job_runs,
  discord_bot.managed_channels,
  discord_bot.reminder_log,
  discord_bot.setup_drafts,
  discord_bot.tasks
TO bot_app;
--> statement-breakpoint

-- The bot's own tables, written directly since the first release.
GRANT INSERT, UPDATE ON TABLE discord_bot.events, discord_bot.tasks TO bot_app;
--> statement-breakpoint

-- Written by what used to be functions. Insert is granted on the whole table, not on
-- columns: Drizzle names every column in an insert, as DEFAULT for those it leaves out,
-- and Postgres asks for the privilege on each one named.
GRANT INSERT ON TABLE
  discord_bot.config_audit,
  discord_bot.event_reminder_log,
  discord_bot.event_step_assignees,
  discord_bot.guild_config,
  discord_bot.interaction_claims,
  discord_bot.job_runs,
  discord_bot.managed_channels,
  discord_bot.reminder_log,
  discord_bot.setup_drafts,
  discord_bot.task_reassignments
TO bot_app;
--> statement-breakpoint

GRANT DELETE ON TABLE discord_bot.interaction_claims TO bot_app;
--> statement-breakpoint

GRANT UPDATE (officer_role_id, admin_role_id, eboard_role_id, events_committee_role_id, treasury_role_id, marketing_role_id, timezone, reminders_enabled, version)
  ON TABLE discord_bot.guild_config TO bot_app;
--> statement-breakpoint

GRANT UPDATE (status) ON TABLE discord_bot.managed_channels TO bot_app;
--> statement-breakpoint

GRANT UPDATE (status, completed_at, completed_by, handoff_claimed_at, handoff_sent_at, not_needed_at, not_needed_by)
  ON TABLE discord_bot.event_steps TO bot_app;
--> statement-breakpoint

GRANT UPDATE (removed_at, removed_by) ON TABLE discord_bot.event_step_assignees TO bot_app;
--> statement-breakpoint

GRANT UPDATE (state, sent_at, message_id, claim_token, claimed_at, attempts)
  ON TABLE discord_bot.event_reminder_log TO bot_app;
--> statement-breakpoint

GRANT UPDATE (state, sent_at, message_id, claim_token, claimed_at, attempts, refused_attempts)
  ON TABLE discord_bot.reminder_log TO bot_app;
--> statement-breakpoint

GRANT UPDATE (status, finished_at, results, error) ON TABLE discord_bot.job_runs TO bot_app;
--> statement-breakpoint

GRANT UPDATE (actor_id, officer_role_id, admin_role_id, eboard_role_id, events_committee_role_id, treasury_role_id, marketing_role_id, fingerprint, created_at)
  ON TABLE discord_bot.setup_drafts TO bot_app;
--> statement-breakpoint
-- The one table bot_app may delete from, and only what the old expiry function deleted:
-- claims past a day. Row level security does not apply to the table owner, so the owner
-- and the old SECURITY DEFINER functions are unaffected.
ALTER TABLE discord_bot.interaction_claims ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

DROP POLICY IF EXISTS interaction_claims_bot_read ON discord_bot.interaction_claims;
--> statement-breakpoint

CREATE POLICY interaction_claims_bot_read ON discord_bot.interaction_claims FOR SELECT TO bot_app USING (true);
--> statement-breakpoint

DROP POLICY IF EXISTS interaction_claims_bot_insert ON discord_bot.interaction_claims;
--> statement-breakpoint

CREATE POLICY interaction_claims_bot_insert ON discord_bot.interaction_claims FOR INSERT TO bot_app WITH CHECK (true);
--> statement-breakpoint

DROP POLICY IF EXISTS interaction_claims_bot_expire ON discord_bot.interaction_claims;
--> statement-breakpoint

CREATE POLICY interaction_claims_bot_expire ON discord_bot.interaction_claims FOR DELETE TO bot_app
  USING (claimed_at < now() - interval '1 day');
