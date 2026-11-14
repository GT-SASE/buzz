-- migrate:up

-- The whole schema on plain Postgres 17, as one starting point. Later changes go in new
-- files beside this one, made with `dbmate new`, and an applied file never changes.
--
-- dbmate runs each file in its own transaction, as the role that will own every object
-- here. That role needs CREATEROLE, to make bot_app below. On Neon it is the project's
-- owner role.
--
-- Access is closed by default. The owner can do anything, and bot_app, the role the bot
-- logs in as, gets only the grants at the end of this file: reads, inserts and updates of
-- events and tasks, and the functions below for every other write. bot_app cannot
-- delete or truncate anything, and nothing deletes rows: tasks and events are
-- soft-deleted, and the history schema keeps the old version of every changed row.

-- Function bodies refer to tables made further down.
SET LOCAL check_function_bodies = off;

-- Objects made from here on start with no grants until this file adds them. Only objects
-- created by the role running this file are covered, which is every object here.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
-- EXECUTE and type USAGE for PUBLIC are built-in defaults, not per-schema ones, so these
-- have no IN SCHEMA clause and cover every schema.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;

-- Schemas -------------------------------------------------------------------------------

CREATE SCHEMA history;

-- Types ---------------------------------------------------------------------------------

CREATE DOMAIN public.discord_id AS text
	CONSTRAINT discord_id_check CHECK ((VALUE ~ '^[0-9]{17,20}$'::text));

CREATE TYPE public.event_reminder_kind AS ENUM (
    'daily_steps',
    'pickup_two_days',
    'pickup_day'
);

CREATE TYPE public.event_status AS ENUM (
    'active',
    'closed'
);

CREATE TYPE public.event_step_kind AS ENUM (
    'budget_sheet',
    'engage_post',
    'budget_approved',
    'food_pickup'
);

CREATE TYPE public.job_run_status AS ENUM (
    'running',
    'succeeded',
    'failed'
);

CREATE TYPE public.managed_channel_status AS ENUM (
    'active',
    'unavailable',
    'removed'
);

CREATE TYPE public.reminder_kind AS ENUM (
    'three_days',
    'one_day',
    'due_day',
    'overdue'
);

CREATE TYPE public.reminder_state AS ENUM (
    'claimed',
    'sent',
    'skipped'
);

CREATE TYPE public.task_status AS ENUM (
    'open',
    'done'
);

CREATE TYPE public.thread_status AS ENUM (
    'pending',
    'active',
    'missing'
);

-- Functions ---------------------------------------------------------------------------

-- The trigger names the row's key columns, in order.
CREATE FUNCTION history.record_row_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO history.row_versions (source_table, operation, row_id, old_row)
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

CREATE FUNCTION public.apply_config_change(p_guild_id text, p_expected_version integer, p_actor_id text, p_reminders_enabled boolean DEFAULT NULL::boolean, p_add_channel_ids text[] DEFAULT '{}'::text[], p_remove_channel_ids text[] DEFAULT '{}'::text[], p_timezone text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_add text[] := coalesce(p_add_channel_ids, '{}');
  v_remove text[] := coalesce(p_remove_channel_ids, '{}');
  v_current public.guild_config%ROWTYPE;
  v_old_channels jsonb;
  v_new_channels jsonb;
  v_reminders boolean;
  v_timezone text;
  v_version integer;
  v_removed integer;
  v_added_ids jsonb;
  v_removed_ids jsonb;
BEGIN
  IF p_reminders_enabled IS NULL
    AND p_timezone IS NULL
    AND cardinality(v_add) = 0
    AND cardinality(v_remove) = 0
  THEN
    RAISE EXCEPTION 'no config change given' USING ERRCODE = '22023';
  END IF;

  -- 25 is the most a Discord select menu can submit at once.
  IF cardinality(v_add) > 25 OR cardinality(v_remove) > 25 THEN
    RAISE EXCEPTION 'too many channels in one change' USING ERRCODE = '22023';
  END IF;

  IF array_position(v_add, NULL) IS NOT NULL OR array_position(v_remove, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'channel IDs cannot be null' USING ERRCODE = '22023';
  END IF;

  IF v_add && v_remove THEN
    RAISE EXCEPTION 'a channel cannot be both added and removed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_current
  FROM public.guild_config
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF NOT FOUND OR v_current.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
  END IF;

  SELECT coalesce(jsonb_agg(channel_id ORDER BY channel_id), '[]') INTO v_old_channels
  FROM public.managed_channels
  WHERE guild_id = p_guild_id AND status = 'active';

  SELECT coalesce(jsonb_agg(DISTINCT channel_id ORDER BY channel_id), '[]') INTO v_added_ids
  FROM unnest(v_add) AS channel_id
  WHERE NOT v_old_channels ? channel_id;

  INSERT INTO public.managed_channels (guild_id, channel_id)
  SELECT DISTINCT p_guild_id, channel_id
  FROM unnest(v_add) AS channel_id
  ON CONFLICT (guild_id, channel_id) DO UPDATE SET status = 'active';

  UPDATE public.managed_channels
  SET status = 'removed'
  WHERE guild_id = p_guild_id
    AND channel_id = ANY (v_remove)
    AND status <> 'removed';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed <> (SELECT count(DISTINCT channel_id) FROM unnest(v_remove) AS channel_id) THEN
    RAISE EXCEPTION 'channel to remove is not managed' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(DISTINCT channel_id ORDER BY channel_id), '[]') INTO v_removed_ids
  FROM unnest(v_remove) AS channel_id;

  SELECT coalesce(jsonb_agg(channel_id ORDER BY channel_id), '[]') INTO v_new_channels
  FROM public.managed_channels
  WHERE guild_id = p_guild_id AND status = 'active';

  UPDATE public.guild_config
  SET reminders_enabled = coalesce(p_reminders_enabled, reminders_enabled),
      timezone = coalesce(p_timezone, timezone),
      version = version + 1
  WHERE guild_id = p_guild_id
  RETURNING version, reminders_enabled, timezone INTO v_version, v_reminders, v_timezone;

  INSERT INTO public.config_audit (guild_id, actor_id, action, old_values, new_values, version_after)
  VALUES (
    p_guild_id,
    p_actor_id,
    'settings',
    jsonb_build_object(
      'reminders_enabled', v_current.reminders_enabled,
      'timezone', v_current.timezone,
      'active_channel_ids', v_old_channels
    ),
    jsonb_build_object(
      'reminders_enabled', v_reminders,
      'timezone', v_timezone,
      'active_channel_ids', v_new_channels,
      'added_channel_ids', v_added_ids,
      'removed_channel_ids', v_removed_ids
    ),
    v_version
  );

  RETURN v_version;
END;
$$;

CREATE FUNCTION public.apply_role_bindings(p_guild_id text, p_expected_version integer, p_actor_id text, p_officer_role_id text, p_admin_role_id text, p_eboard_role_id text, p_events_committee_role_id text, p_treasury_role_id text, p_marketing_role_id text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_current public.guild_config%ROWTYPE;
  v_old_values jsonb;
  v_version integer;
BEGIN
  SELECT * INTO v_current
  FROM public.guild_config
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_current.version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    v_old_values := jsonb_build_object(
      'officer_role_id', v_current.officer_role_id,
      'admin_role_id', v_current.admin_role_id,
      'eboard_role_id', v_current.eboard_role_id,
      'events_committee_role_id', v_current.events_committee_role_id,
      'treasury_role_id', v_current.treasury_role_id,
      'marketing_role_id', v_current.marketing_role_id
    );

    UPDATE public.guild_config
    SET officer_role_id = p_officer_role_id,
        admin_role_id = p_admin_role_id,
        eboard_role_id = p_eboard_role_id,
        events_committee_role_id = p_events_committee_role_id,
        treasury_role_id = p_treasury_role_id,
        marketing_role_id = p_marketing_role_id,
        version = version + 1
    WHERE guild_id = p_guild_id
    RETURNING version INTO v_version;
  ELSE
    IF p_expected_version IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    -- A concurrent first setup can pass the check above. The conflict leaves
    -- v_version null, which is reported as a stale version.
    INSERT INTO public.guild_config (
      guild_id, officer_role_id, admin_role_id, eboard_role_id,
      events_committee_role_id, treasury_role_id, marketing_role_id
    )
    VALUES (
      p_guild_id, p_officer_role_id, p_admin_role_id, p_eboard_role_id,
      p_events_committee_role_id, p_treasury_role_id, p_marketing_role_id
    )
    ON CONFLICT (guild_id) DO NOTHING
    RETURNING version INTO v_version;

    IF v_version IS NULL THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;
  END IF;

  INSERT INTO public.config_audit (guild_id, actor_id, action, old_values, new_values, version_after)
  VALUES (
    p_guild_id,
    p_actor_id,
    'role_bindings',
    v_old_values,
    jsonb_build_object(
      'officer_role_id', p_officer_role_id,
      'admin_role_id', p_admin_role_id,
      'eboard_role_id', p_eboard_role_id,
      'events_committee_role_id', p_events_committee_role_id,
      'treasury_role_id', p_treasury_role_id,
      'marketing_role_id', p_marketing_role_id
    ),
    v_version
  );

  RETURN v_version;
END;
$$;

-- Adds a person to a step. True if this call added them, false if they were already on
-- it. Raises 22023 for Budget approved, and CF431 once the step has its most people: 10,
-- or 15 for Food pickup.
CREATE FUNCTION public.assign_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_user_id text, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_count integer;
BEGIN
  IF p_kind IS NULL OR p_kind = 'budget_approved' THEN
    RAISE EXCEPTION 'this step has no assignees' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.event_step_assignees
    WHERE event_id = p_event_id AND kind = p_kind AND user_id = p_user_id AND removed_at IS NULL
  ) THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.event_step_assignees
  WHERE event_id = p_event_id AND kind = p_kind AND removed_at IS NULL;
  IF v_count >= (CASE WHEN p_kind = 'food_pickup' THEN 15 ELSE 10 END) THEN
    RAISE EXCEPTION 'step assignee limit reached' USING ERRCODE = 'CF431';
  END IF;

  INSERT INTO public.event_step_assignees (event_id, guild_id, kind, user_id, assigned_by)
  VALUES (p_event_id, p_guild_id, p_kind, p_user_id, p_actor_id);

  IF p_kind = 'food_pickup' THEN
    PERFORM public.sync_food_pickup_step(p_event_id, p_actor_id);
  END IF;

  RETURN true;
END;
$$;

CREATE FUNCTION public.begin_job_run(p_job_name text, p_stale_after_seconds integer, p_slot_start timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_slot_start IS NULL THEN
    RAISE EXCEPTION 'slot start is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('job_runs:' || p_job_name, 0)
  );

  UPDATE public.job_runs
  SET status = 'failed',
      finished_at = now(),
      error = 'abandoned'
  WHERE job_name = p_job_name
    AND status = 'running'
    AND (
      heartbeat_at < now() - make_interval(secs => p_stale_after_seconds)
      OR heartbeat_at > clock_timestamp()
    );

  IF EXISTS (
    SELECT 1
    FROM public.job_runs
    WHERE job_name = p_job_name
      AND status = 'succeeded'
      AND started_at >= p_slot_start
      AND started_at <= clock_timestamp()
  ) THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.job_runs (job_name)
  VALUES (p_job_name)
  ON CONFLICT (job_name) WHERE status = 'running' DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

CREATE FUNCTION public.check_guild_timezone() RETURNS trigger
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

CREATE FUNCTION public.claim_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.events
  SET post_attempt_at = now()
  WHERE id = p_event_id
    AND guild_id = p_guild_id
    AND deleted_at IS NULL
    AND thread_status = 'pending'
    AND post_attempt_at IS NULL;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.claim_event_reminder(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_token uuid;
BEGIN
  INSERT INTO public.event_reminder_log (event_id, kind, reminder_date)
  SELECT p_event_id, p_kind, p_reminder_date
  WHERE public.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  ON CONFLICT (event_id, kind, reminder_date) DO NOTHING
  RETURNING claim_token INTO v_token;

  RETURN v_token;
END;
$$;

CREATE FUNCTION public.claim_interaction(p_interaction_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.interaction_claims (interaction_id)
  VALUES (p_interaction_id)
  ON CONFLICT (interaction_id) DO NOTHING;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.claim_reminder(p_task_id uuid, p_kind public.reminder_kind, p_due_date date, p_assignee_id text DEFAULT NULL::text, p_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_token uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tasks AS task
    WHERE task.id = p_task_id
      AND task.due_date = p_due_date
      AND task.status = 'open'
      AND task.deleted_at IS NULL
      AND (
        task.assignee_id <> p_assignee_id
        OR task.updated_at <> p_updated_at
      )
  ) THEN
    RAISE EXCEPTION 'task changed since it was read' USING ERRCODE = 'CF412';
  END IF;

  INSERT INTO public.reminder_log (task_id, kind, due_date)
  SELECT task.id, p_kind, task.due_date
  FROM public.tasks AS task
  JOIN public.events AS event
    ON event.id = task.event_id AND event.guild_id = task.guild_id
  JOIN public.managed_channels AS channel
    ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
  JOIN public.guild_config AS config
    ON config.guild_id = task.guild_id
  WHERE task.id = p_task_id
    AND task.due_date = p_due_date
    AND task.status = 'open'
    AND task.deleted_at IS NULL
    AND event.status = 'active'
    AND event.deleted_at IS NULL
    AND channel.status = 'active'
    AND config.reminders_enabled
  ON CONFLICT (task_id, kind, due_date) DO NOTHING
  RETURNING claim_token INTO v_token;

  RETURN v_token;
END;
$$;

CREATE FUNCTION public.claim_step_handoff(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step has no hand-off' USING ERRCODE = '22023';
  END IF;

  -- As every other step function: a closed event takes no more step changes.
  IF EXISTS (
    SELECT 1 FROM public.events AS event
    WHERE event.id = p_event_id AND event.guild_id = p_guild_id
      AND event.deleted_at IS NULL AND event.status <> 'active'
  ) THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  UPDATE public.event_steps AS step
  SET handoff_claimed_at = now()
  WHERE step.event_id = p_event_id
    AND step.guild_id = p_guild_id
    AND step.kind = p_kind
    AND step.status = 'done'
    AND step.handoff_claimed_at IS NULL
    AND EXISTS (
      SELECT 1 FROM public.events AS event
      WHERE event.id = p_event_id AND event.guild_id = p_guild_id
        AND event.deleted_at IS NULL AND event.status = 'active'
    );

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.complete_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_status public.task_status;
  v_event public.events%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step cannot be marked done' USING ERRCODE = '22023';
  END IF;

  SELECT status INTO v_status
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  IF v_status <> 'open' THEN
    RETURN false;
  END IF;

  UPDATE public.event_steps
  SET status = 'done',
      completed_at = now(),
      completed_by = p_actor_id
  WHERE event_id = p_event_id AND kind = p_kind;

  RETURN true;
END;
$$;

CREATE FUNCTION public.create_event_steps() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.event_steps (event_id, guild_id, kind)
  SELECT NEW.id, NEW.guild_id, kind
  FROM unnest(enum_range(NULL::public.event_step_kind)) AS kind;
  RETURN NULL;
END;
$$;

-- The one way to change a task's text, date or person. A new person counts against the
-- officer's daily limit in the same transaction as the change, so the limit can be
-- neither skipped nor spent on an edit that did not land. NULL when no open, live task
-- with that ID in that guild is at the version the caller read.
CREATE FUNCTION public.edit_task(p_task_id uuid, p_guild_id text, p_expected_updated_at timestamp with time zone, p_description text, p_due_date date, p_assignee_id text, p_actor_id text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_assignee text;
  v_task jsonb;
BEGIN
  SELECT task.assignee_id INTO v_assignee
  FROM public.tasks AS task
  WHERE task.id = p_task_id
    AND task.guild_id = p_guild_id
    AND task.updated_at = p_expected_updated_at
    AND task.status = 'open'
    AND task.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_assignee IS DISTINCT FROM p_assignee_id THEN
    INSERT INTO public.task_reassignments (guild_id, actor_id, task_id)
    VALUES (p_guild_id, p_actor_id, p_task_id);
  END IF;

  UPDATE public.tasks AS task
  SET description = p_description, due_date = p_due_date, assignee_id = p_assignee_id
  WHERE task.id = p_task_id
  RETURNING pg_catalog.jsonb_build_object(
    'id', task.id,
    'event_id', task.event_id,
    'guild_id', task.guild_id,
    'assignee_id', task.assignee_id,
    'description', task.description,
    'due_date', task.due_date,
    'status', task.status,
    'completed_at', task.completed_at,
    'created_by', task.created_by,
    'deleted_at', task.deleted_at,
    'updated_at', task.updated_at
  ) INTO v_task;
  RETURN v_task;
END;
$$;

CREATE FUNCTION public.enforce_reassignment_quota() RETURNS trigger
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
    SELECT count(*) FROM public.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM public.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_task_quotas() RETURNS trigger
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
    SELECT count(*) FROM public.tasks
    WHERE event_id = NEW.event_id AND deleted_at IS NULL
  ) >= 100 THEN
    RAISE EXCEPTION 'event task limit reached' USING ERRCODE = 'CF429';
  END IF;

  IF (
    SELECT count(*) FROM public.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM public.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.event_reminder_allowed(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.events AS event
    JOIN public.managed_channels AS channel
      ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
    JOIN public.guild_config AS config
      ON config.guild_id = event.guild_id
    WHERE event.id = p_event_id
      AND event.status = 'active'
      AND event.deleted_at IS NULL
      AND channel.status = 'active'
      AND config.reminders_enabled
      -- Up to the event, and today or yesterday in the guild's zone, so a run can claim
      -- neither a day long gone nor one still to come. Which day each kind goes out is
      -- the planner's to decide.
      AND p_reminder_date <= event.event_date
      AND p_reminder_date >= (pg_catalog.now() AT TIME ZONE config.timezone)::date - 1
      AND p_reminder_date <= (pg_catalog.now() AT TIME ZONE config.timezone)::date
      AND (
        p_kind = 'daily_steps'
        OR EXISTS (
          SELECT 1 FROM public.event_steps AS step
          WHERE step.event_id = event.id AND step.kind = 'food_pickup' AND step.status = 'done'
        )
      )
  );
$$;

CREATE FUNCTION public.expire_interaction_claims() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.interaction_claims
  WHERE claimed_at < now() - interval '1 day';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE FUNCTION public.finish_job_run(p_id uuid, p_finished_at timestamp with time zone, p_results jsonb, p_error text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_job_name text;
  v_row public.job_runs;
BEGIN
  SELECT job_name INTO v_job_name FROM public.job_runs WHERE id = p_id;
  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('job_runs:' || v_job_name, 0)
  );

  UPDATE public.job_runs
  SET status = CASE WHEN p_error IS NULL
                 THEN 'succeeded'::public.job_run_status
                 ELSE 'failed'::public.job_run_status
               END,
      finished_at = LEAST(p_finished_at, now()),
      results = p_results,
      error = p_error
  WHERE id = p_id AND status = 'running'
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_row));
END;
$$;

CREATE FUNCTION public.mark_channel_unavailable(p_guild_id text, p_channel_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_changed boolean;
BEGIN
  UPDATE public.managed_channels
  SET status = 'unavailable'
  WHERE guild_id = p_guild_id AND channel_id = p_channel_id AND status = 'active';
  v_changed := FOUND;

  INSERT INTO public.job_runs (job_name, status, finished_at, results)
  VALUES (
    'mark_channel_unavailable',
    'succeeded',
    now(),
    jsonb_build_object('guild_id', p_guild_id, 'channel_id', p_channel_id, 'changed', v_changed)
  );

  RETURN v_changed;
END;
$$;

CREATE FUNCTION public.mark_event_reminder_sent(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date, p_claim_token uuid, p_message_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.event_reminder_log
  SET state = 'sent',
      sent_at = now(),
      message_id = p_message_id
  WHERE event_id = p_event_id
    AND kind = p_kind
    AND reminder_date = p_reminder_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.mark_event_reminder_skipped(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.event_reminder_log
  SET state = 'skipped'
  WHERE event_id = p_event_id
    AND kind = p_kind
    AND reminder_date = p_reminder_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.mark_reminder_sent(p_task_id uuid, p_kind public.reminder_kind, p_due_date date, p_claim_token uuid, p_message_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.reminder_log
  SET state = 'sent',
      sent_at = now(),
      message_id = p_message_id
  WHERE task_id = p_task_id
    AND kind = p_kind
    AND due_date = p_due_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.mark_reminder_skipped(p_task_id uuid, p_kind public.reminder_kind, p_due_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.reminder_log
  SET state = 'skipped'
  WHERE task_id = p_task_id
    AND kind = p_kind
    AND due_date = p_due_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.mark_step_handoff_sent(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.event_steps
  SET handoff_sent_at = now()
  WHERE event_id = p_event_id
    AND guild_id = p_guild_id
    AND kind = p_kind
    AND handoff_claimed_at IS NOT NULL
    AND handoff_sent_at IS NULL;

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.reclaim_event_reminder(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date, p_claim_token uuid, p_stale_after_seconds integer) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_token uuid;
BEGIN
  UPDATE public.event_reminder_log AS log
  SET claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempts = log.attempts + 1
  WHERE log.event_id = p_event_id
    AND log.kind = p_kind
    AND log.reminder_date = p_reminder_date
    AND log.state = 'claimed'
    AND log.claim_token = p_claim_token
    AND log.claimed_at < now() - make_interval(secs => p_stale_after_seconds)
    AND public.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  RETURNING log.claim_token INTO v_token;

  RETURN v_token;
END;
$$;

CREATE FUNCTION public.reclaim_reminder(p_task_id uuid, p_kind public.reminder_kind, p_due_date date, p_claim_token uuid, p_stale_after_seconds integer, p_assignee_id text DEFAULT NULL::text, p_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_token uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tasks AS task
    WHERE task.id = p_task_id
      AND task.due_date = p_due_date
      AND task.status = 'open'
      AND task.deleted_at IS NULL
      AND (
        task.assignee_id <> p_assignee_id
        OR task.updated_at <> p_updated_at
      )
  ) THEN
    RAISE EXCEPTION 'task changed since it was read' USING ERRCODE = 'CF412';
  END IF;

  UPDATE public.reminder_log AS log
  SET claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempts = log.attempts + 1
  WHERE log.task_id = p_task_id
    AND log.kind = p_kind
    AND log.due_date = p_due_date
    AND log.state = 'claimed'
    AND log.claim_token = p_claim_token
    AND log.claimed_at < now() - make_interval(secs => p_stale_after_seconds)
    AND EXISTS (
      SELECT 1
      FROM public.tasks AS task
      JOIN public.events AS event
        ON event.id = task.event_id AND event.guild_id = task.guild_id
      JOIN public.managed_channels AS channel
        ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
      JOIN public.guild_config AS config
        ON config.guild_id = task.guild_id
      WHERE task.id = p_task_id
        AND task.due_date = p_due_date
        AND task.status = 'open'
        AND task.deleted_at IS NULL
        AND event.status = 'active'
        AND event.deleted_at IS NULL
        AND channel.status = 'active'
        AND config.reminders_enabled
    )
  RETURNING log.claim_token INTO v_token;

  RETURN v_token;
END;
$$;

CREATE FUNCTION public.record_reminder_refused(p_task_id uuid, p_kind public.reminder_kind, p_due_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.reminder_log
  SET refused_attempts = refused_attempts + 1
  WHERE task_id = p_task_id
    AND kind = p_kind
    AND due_date = p_due_date
    AND state = 'claimed'
    AND claim_token = p_claim_token
    AND refused_attempts < attempts;
  RETURN FOUND;
END;
$$;

-- A soft-deleted task stays deleted. Bringing one back could revive it on a closed or
-- deleted event and past the event's task limit, which every other path checks. Only
-- the tables' owner may, by hand, as docs/RECOVERY.md describes.
CREATE FUNCTION public.refuse_undelete() RETURNS trigger
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

-- A closed event stays closed. The bot tells people there is no way to reopen one, and
-- reopening would bring back reminders for its tasks. Only the tables' owner may, by
-- hand, as docs/RECOVERY.md describes.
CREATE FUNCTION public.refuse_reopen() RETURNS trigger
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

CREATE FUNCTION public.release_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  UPDATE public.events
  SET post_attempt_at = NULL
  WHERE id = p_event_id
    AND guild_id = p_guild_id
    AND deleted_at IS NULL
    AND thread_status = 'pending';

  RETURN FOUND;
END;
$$;

CREATE FUNCTION public.require_open_parent() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_channel_status public.managed_channel_status;
  v_event_status public.event_status;
  v_event_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    SELECT status INTO v_channel_status
    FROM public.managed_channels
    WHERE guild_id = NEW.guild_id AND channel_id = NEW.channel_id
    FOR SHARE;

    IF v_channel_status = 'removed' THEN
      RAISE EXCEPTION 'channel has been removed' USING ERRCODE = 'CF410';
    END IF;
  ELSE
    SELECT status, deleted_at INTO v_event_status, v_event_deleted_at
    FROM public.events
    WHERE id = NEW.event_id AND guild_id = NEW.guild_id
    FOR SHARE;

    IF v_event_status = 'closed' OR v_event_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'event is closed or deleted' USING ERRCODE = 'CF410';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.save_setup_draft(p_guild_id text, p_actor_id text, p_officer_role_id text, p_admin_role_id text, p_eboard_role_id text, p_events_committee_role_id text, p_treasury_role_id text, p_marketing_role_id text, p_fingerprint text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
BEGIN
  INSERT INTO public.setup_drafts (
    guild_id, actor_id, officer_role_id, admin_role_id, eboard_role_id,
    events_committee_role_id, treasury_role_id, marketing_role_id, fingerprint
  )
  VALUES (
    p_guild_id, p_actor_id, p_officer_role_id, p_admin_role_id, p_eboard_role_id,
    p_events_committee_role_id, p_treasury_role_id, p_marketing_role_id, p_fingerprint
  )
  ON CONFLICT (guild_id) DO UPDATE
  SET actor_id = EXCLUDED.actor_id,
      officer_role_id = EXCLUDED.officer_role_id,
      admin_role_id = EXCLUDED.admin_role_id,
      eboard_role_id = EXCLUDED.eboard_role_id,
      events_committee_role_id = EXCLUDED.events_committee_role_id,
      treasury_role_id = EXCLUDED.treasury_role_id,
      marketing_role_id = EXCLUDED.marketing_role_id,
      fingerprint = EXCLUDED.fingerprint,
      created_at = now();

  RETURN true;
END;
$$;

-- Sets the time of the food pickup. Returns whether Food pickup is now done, which also
-- needs at least one person on it.
CREATE FUNCTION public.set_event_pickup_time(p_event_id uuid, p_guild_id text, p_pickup_time time without time zone, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_event public.events%ROWTYPE;
BEGIN
  IF p_pickup_time IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'a pickup time and an actor are needed' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = 'food_pickup'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR UPDATE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  UPDATE public.events
  SET pickup_time = p_pickup_time
  WHERE id = p_event_id;

  RETURN public.sync_food_pickup_step(p_event_id, p_actor_id) = 'done';
END;
$$;

CREATE FUNCTION public.set_updated_at() RETURNS trigger
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

CREATE FUNCTION public.soft_delete_event(p_event_id uuid, p_guild_id text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_deleted integer;
BEGIN
  PERFORM 1
  FROM public.tasks
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND deleted_at IS NULL
  ORDER BY id
  FOR NO KEY UPDATE;

  UPDATE public.events
  SET deleted_at = now()
  WHERE id = p_event_id AND guild_id = p_guild_id AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.tasks
  SET deleted_at = now()
  WHERE event_id = p_event_id AND deleted_at IS NULL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted;
END;
$$;

CREATE FUNCTION public.sync_food_pickup_step(p_event_id uuid, p_actor_id text) RETURNS public.task_status
    LANGUAGE plpgsql
    SET search_path TO ''
    AS $$
DECLARE
  v_ready boolean;
  v_status public.task_status;
BEGIN
  SELECT event.pickup_time IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.event_step_assignees AS assignee
      WHERE assignee.event_id = event.id
        AND assignee.kind = 'food_pickup'
        AND assignee.removed_at IS NULL
    )
  INTO v_ready
  FROM public.events AS event
  WHERE event.id = p_event_id;

  UPDATE public.event_steps
  SET status = CASE WHEN v_ready THEN 'done'::public.task_status ELSE 'open'::public.task_status END,
      completed_at = CASE WHEN v_ready THEN coalesce(completed_at, now()) END,
      completed_by = CASE WHEN v_ready THEN coalesce(completed_by, p_actor_id) END
  WHERE event_id = p_event_id AND kind = 'food_pickup'
  RETURNING status INTO v_status;

  RETURN v_status;
END;
$$;

CREATE FUNCTION public.unassign_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_user_id text, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_event public.events%ROWTYPE;
  v_removed boolean;
BEGIN
  IF p_kind IS NULL OR p_kind = 'budget_approved' THEN
    RAISE EXCEPTION 'this step has no assignees' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION 'an actor is needed' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = p_kind
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_event
  FROM public.events
  WHERE id = p_event_id AND guild_id = p_guild_id
  FOR SHARE;
  IF v_event.deleted_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  IF v_event.status = 'closed' THEN
    RAISE EXCEPTION 'event is closed' USING ERRCODE = 'CF410';
  END IF;

  UPDATE public.event_step_assignees
  SET removed_at = now(),
      removed_by = p_actor_id
  WHERE event_id = p_event_id AND kind = p_kind AND user_id = p_user_id AND removed_at IS NULL;
  v_removed := FOUND;

  IF v_removed AND p_kind = 'food_pickup' THEN
    PERFORM public.sync_food_pickup_step(p_event_id, p_actor_id);
  END IF;

  RETURN v_removed;
END;
$$;

-- Tables --------------------------------------------------------------------------------

CREATE TABLE history.row_versions (
    id bigint NOT NULL,
    source_table text NOT NULL,
    operation text NOT NULL,
    row_id text NOT NULL,
    old_row jsonb NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT row_versions_operation_known CHECK ((operation = ANY (ARRAY['UPDATE'::text, 'DELETE'::text])))
);

ALTER TABLE history.row_versions ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME history.row_versions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.config_audit (
    id bigint NOT NULL,
    guild_id public.discord_id NOT NULL,
    actor_id public.discord_id NOT NULL,
    action text NOT NULL,
    old_values jsonb,
    new_values jsonb NOT NULL,
    version_after integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT config_audit_action_known CHECK ((action = ANY (ARRAY['role_bindings'::text, 'settings'::text])))
);

ALTER TABLE public.config_audit ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.config_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.event_reminder_log (
    event_id uuid NOT NULL,
    kind public.event_reminder_kind NOT NULL,
    reminder_date date NOT NULL,
    state public.reminder_state DEFAULT 'claimed'::public.reminder_state NOT NULL,
    claim_token uuid DEFAULT gen_random_uuid() NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    message_id public.discord_id,
    CONSTRAINT event_reminder_log_attempts_positive CHECK ((attempts >= 1)),
    CONSTRAINT event_reminder_log_date_range CHECK (((reminder_date >= '2000-01-01'::date) AND (reminder_date <= '9999-12-31'::date))),
    CONSTRAINT event_reminder_log_message_only_when_sent CHECK (((message_id IS NULL) OR (state = 'sent'::public.reminder_state))),
    CONSTRAINT event_reminder_log_sent_at_matches_state CHECK (((sent_at IS NOT NULL) = (state = 'sent'::public.reminder_state)))
);

CREATE TABLE public.event_step_assignees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    guild_id public.discord_id NOT NULL,
    kind public.event_step_kind NOT NULL,
    user_id public.discord_id NOT NULL,
    assigned_by public.discord_id NOT NULL,
    removed_at timestamp with time zone,
    removed_by public.discord_id,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_step_assignees_kind_assignable CHECK ((kind <> 'budget_approved'::public.event_step_kind)),
    CONSTRAINT event_step_assignees_removed_together CHECK (((removed_at IS NULL) = (removed_by IS NULL)))
);

CREATE TABLE public.event_steps (
    event_id uuid NOT NULL,
    guild_id public.discord_id NOT NULL,
    kind public.event_step_kind NOT NULL,
    status public.task_status DEFAULT 'open'::public.task_status NOT NULL,
    completed_at timestamp with time zone,
    completed_by public.discord_id,
    handoff_claimed_at timestamp with time zone,
    handoff_sent_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT event_steps_completed_by_matches_status CHECK (((completed_by IS NOT NULL) = (status = 'done'::public.task_status))),
    CONSTRAINT event_steps_completed_matches_status CHECK (((completed_at IS NOT NULL) = (status = 'done'::public.task_status))),
    CONSTRAINT event_steps_handoff_only_when_done CHECK (((handoff_claimed_at IS NULL) OR ((status = 'done'::public.task_status) AND (kind <> 'food_pickup'::public.event_step_kind)))),
    CONSTRAINT event_steps_handoff_sent_after_claim CHECK (((handoff_sent_at IS NULL) OR (handoff_claimed_at IS NOT NULL)))
);

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    guild_id public.discord_id NOT NULL,
    channel_id public.discord_id NOT NULL,
    name text NOT NULL,
    event_date date NOT NULL,
    thread_id public.discord_id,
    overview_message_id public.discord_id,
    status public.event_status DEFAULT 'active'::public.event_status NOT NULL,
    thread_status public.thread_status DEFAULT 'pending'::public.thread_status NOT NULL,
    created_by public.discord_id NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    post_attempt_at timestamp with time zone,
    pickup_time time without time zone,
    CONSTRAINT events_event_date_range CHECK (((event_date >= '2000-01-01'::date) AND (event_date <= '9999-12-31'::date))),
    CONSTRAINT events_name_length CHECK ((char_length(name) >= 1)),
    CONSTRAINT events_thread_matches_status CHECK (((thread_id IS NULL) = (thread_status = 'pending'::public.thread_status)))
);

CREATE TABLE public.guild_config (
    guild_id public.discord_id NOT NULL,
    officer_role_id public.discord_id NOT NULL,
    admin_role_id public.discord_id NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    reminders_enabled boolean DEFAULT true NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    eboard_role_id public.discord_id,
    events_committee_role_id public.discord_id,
    treasury_role_id public.discord_id,
    marketing_role_id public.discord_id,
    CONSTRAINT guild_config_admin_not_everyone CHECK (((admin_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_eboard_not_everyone CHECK (((eboard_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_events_committee_not_everyone CHECK (((events_committee_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_marketing_not_everyone CHECK (((marketing_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_officer_not_everyone CHECK (((officer_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_treasury_not_everyone CHECK (((treasury_role_id)::text <> (guild_id)::text)),
    CONSTRAINT guild_config_version_positive CHECK ((version >= 1))
);

-- Lets a mutating handler run once per Discord interaction, even if the request is
-- delivered or retried more than once.
--
-- Retention: an interaction's token lasts 15 minutes, after which Discord can no longer
-- be answered for it, so a row is only useful for about that long. The daily cron calls
-- expire_interaction_claims, which deletes rows older than one day. The bot's role has no
-- access to this table except through that function and claim_interaction.
CREATE TABLE public.interaction_claims (
    interaction_id public.discord_id NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.job_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_name text NOT NULL,
    status public.job_run_status DEFAULT 'running'::public.job_run_status NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    heartbeat_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    results jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    CONSTRAINT job_runs_error_size CHECK ((char_length(error) <= 4000)),
    CONSTRAINT job_runs_finished_matches_status CHECK (((finished_at IS NULL) = (status = 'running'::public.job_run_status))),
    CONSTRAINT job_runs_job_name_length CHECK (((char_length(job_name) >= 1) AND (char_length(job_name) <= 64))),
    CONSTRAINT job_runs_results_size CHECK ((char_length((results)::text) <= 16000))
);

CREATE TABLE public.managed_channels (
    guild_id public.discord_id NOT NULL,
    channel_id public.discord_id NOT NULL,
    status public.managed_channel_status DEFAULT 'active'::public.managed_channel_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.reminder_log (
    task_id uuid NOT NULL,
    kind public.reminder_kind NOT NULL,
    due_date date NOT NULL,
    state public.reminder_state DEFAULT 'claimed'::public.reminder_state NOT NULL,
    claim_token uuid DEFAULT gen_random_uuid() NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    message_id public.discord_id,
    refused_attempts integer DEFAULT 0 NOT NULL,
    CONSTRAINT reminder_log_attempts_positive CHECK ((attempts >= 1)),
    CONSTRAINT reminder_log_due_date_range CHECK (((due_date >= '2000-01-01'::date) AND (due_date <= '9999-12-31'::date))),
    CONSTRAINT reminder_log_message_only_when_sent CHECK (((message_id IS NULL) OR (state = 'sent'::public.reminder_state))),
    CONSTRAINT reminder_log_refused_attempts_range CHECK (((refused_attempts >= 0) AND (refused_attempts <= attempts))),
    CONSTRAINT reminder_log_sent_at_matches_state CHECK (((sent_at IS NOT NULL) = (state = 'sent'::public.reminder_state)))
);

CREATE TABLE public.setup_drafts (
    guild_id public.discord_id NOT NULL,
    actor_id public.discord_id NOT NULL,
    officer_role_id public.discord_id NOT NULL,
    admin_role_id public.discord_id NOT NULL,
    eboard_role_id public.discord_id NOT NULL,
    events_committee_role_id public.discord_id NOT NULL,
    treasury_role_id public.discord_id NOT NULL,
    marketing_role_id public.discord_id NOT NULL,
    fingerprint text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT setup_drafts_admin_not_everyone CHECK (((admin_role_id)::text <> (guild_id)::text)),
    CONSTRAINT setup_drafts_eboard_not_everyone CHECK (((eboard_role_id)::text <> (guild_id)::text)),
    CONSTRAINT setup_drafts_events_committee_not_everyone CHECK (((events_committee_role_id)::text <> (guild_id)::text)),
    CONSTRAINT setup_drafts_fingerprint_shape CHECK ((fingerprint ~ '^[A-Za-z0-9_-]{8,64}$'::text)),
    CONSTRAINT setup_drafts_marketing_not_everyone CHECK (((marketing_role_id)::text <> (guild_id)::text)),
    CONSTRAINT setup_drafts_officer_not_everyone CHECK (((officer_role_id)::text <> (guild_id)::text)),
    CONSTRAINT setup_drafts_treasury_not_everyone CHECK (((treasury_role_id)::text <> (guild_id)::text))
);

CREATE TABLE public.task_reassignments (
    id bigint NOT NULL,
    guild_id public.discord_id NOT NULL,
    actor_id public.discord_id NOT NULL,
    task_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.task_reassignments ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.task_reassignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    guild_id public.discord_id NOT NULL,
    assignee_id public.discord_id NOT NULL,
    description text NOT NULL,
    due_date date NOT NULL,
    status public.task_status DEFAULT 'open'::public.task_status NOT NULL,
    completed_at timestamp with time zone,
    created_by public.discord_id NOT NULL,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tasks_completed_matches_status CHECK (((completed_at IS NOT NULL) = (status = 'done'::public.task_status))),
    CONSTRAINT tasks_description_length CHECK ((char_length(description) >= 1)),
    CONSTRAINT tasks_due_date_range CHECK (((due_date >= '2000-01-01'::date) AND (due_date <= '9999-12-31'::date)))
);

-- Keys ----------------------------------------------------------------------------------

ALTER TABLE ONLY history.row_versions
    ADD CONSTRAINT row_versions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.config_audit
    ADD CONSTRAINT config_audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event_reminder_log
    ADD CONSTRAINT event_reminder_log_pkey PRIMARY KEY (event_id, kind, reminder_date);

ALTER TABLE ONLY public.event_step_assignees
    ADD CONSTRAINT event_step_assignees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.event_steps
    ADD CONSTRAINT event_steps_pkey PRIMARY KEY (event_id, kind);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_id_guild_unique UNIQUE (id, guild_id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.guild_config
    ADD CONSTRAINT guild_config_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.interaction_claims
    ADD CONSTRAINT interaction_claims_pkey PRIMARY KEY (interaction_id);

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.managed_channels
    ADD CONSTRAINT managed_channels_pkey PRIMARY KEY (guild_id, channel_id);

ALTER TABLE ONLY public.reminder_log
    ADD CONSTRAINT reminder_log_pkey PRIMARY KEY (task_id, kind, due_date);

ALTER TABLE ONLY public.setup_drafts
    ADD CONSTRAINT setup_drafts_pkey PRIMARY KEY (guild_id);

ALTER TABLE ONLY public.task_reassignments
    ADD CONSTRAINT task_reassignments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);

-- Indexes -------------------------------------------------------------------------------

CREATE INDEX row_versions_lookup_idx ON history.row_versions USING btree (source_table, row_id, id DESC);

CREATE INDEX config_audit_guild_idx ON public.config_audit USING btree (guild_id, id DESC);

CREATE INDEX event_reminder_log_open_claims_idx ON public.event_reminder_log USING btree (claimed_at) WHERE (state = 'claimed'::public.reminder_state);

CREATE INDEX event_step_assignees_by_user_idx ON public.event_step_assignees USING btree (guild_id, user_id) WHERE (removed_at IS NULL);

CREATE UNIQUE INDEX event_step_assignees_live_uq ON public.event_step_assignees USING btree (event_id, kind, user_id) WHERE (removed_at IS NULL);

CREATE INDEX events_channel_idx ON public.events USING btree (guild_id, channel_id);

-- The task commands' lookup of a post's event, including deleted ones.
CREATE INDEX events_by_thread_idx ON public.events USING btree (guild_id, thread_id) WHERE (thread_id IS NOT NULL);

-- The event reminder run's read of live, active events by date, across guilds.
CREATE INDEX events_open_by_date_idx ON public.events USING btree (status, event_date) WHERE (deleted_at IS NULL);

CREATE INDEX events_live_by_date_idx ON public.events USING btree (guild_id, event_date) WHERE (deleted_at IS NULL);

CREATE UNIQUE INDEX events_live_thread_uq ON public.events USING btree (thread_id) WHERE ((deleted_at IS NULL) AND (thread_id IS NOT NULL));

-- /event create resumes an event still waiting for its post rather than making
-- another. This stops an officer's retry from racing their own insert that committed
-- after the bot gave up on it.
CREATE UNIQUE INDEX events_one_pending_create_uq ON public.events USING btree (guild_id, channel_id, created_by, name, event_date) WHERE ((deleted_at IS NULL) AND (thread_status = 'pending'::public.thread_status));

CREATE INDEX job_runs_latest_idx ON public.job_runs USING btree (job_name, started_at DESC);

CREATE UNIQUE INDEX job_runs_one_running_idx ON public.job_runs USING btree (job_name) WHERE (status = 'running'::public.job_run_status);

CREATE INDEX reminder_log_open_claims_idx ON public.reminder_log USING btree (claimed_at) WHERE (state = 'claimed'::public.reminder_state);

CREATE INDEX task_reassignments_by_actor_idx ON public.task_reassignments USING btree (guild_id, actor_id, created_at);

CREATE INDEX tasks_by_creator_idx ON public.tasks USING btree (guild_id, created_by, created_at);

CREATE INDEX tasks_event_idx ON public.tasks USING btree (event_id);

CREATE INDEX tasks_open_by_assignee_idx ON public.tasks USING btree (guild_id, assignee_id, due_date) WHERE ((status = 'open'::public.task_status) AND (deleted_at IS NULL));

CREATE INDEX tasks_open_by_due_date_idx ON public.tasks USING btree (due_date, guild_id) WHERE ((status = 'open'::public.task_status) AND (deleted_at IS NULL));

-- Triggers ------------------------------------------------------------------------------

CREATE TRIGGER event_step_assignees_record_update AFTER UPDATE ON public.event_step_assignees FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('id');

CREATE TRIGGER event_steps_record_update AFTER UPDATE ON public.event_steps FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('event_id', 'kind');

CREATE TRIGGER event_steps_set_updated_at BEFORE UPDATE ON public.event_steps FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER events_create_steps AFTER INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.create_event_steps();

CREATE TRIGGER events_record_update AFTER UPDATE ON public.events FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('id');

CREATE TRIGGER events_refuse_reopen BEFORE UPDATE OF status ON public.events FOR EACH ROW EXECUTE FUNCTION public.refuse_reopen();

CREATE TRIGGER events_refuse_undelete BEFORE UPDATE OF deleted_at ON public.events FOR EACH ROW EXECUTE FUNCTION public.refuse_undelete();

CREATE TRIGGER events_require_open_parent BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();

CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER guild_config_record_update AFTER UPDATE ON public.guild_config FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('guild_id');

CREATE TRIGGER guild_config_check_timezone BEFORE INSERT OR UPDATE OF timezone ON public.guild_config FOR EACH ROW EXECUTE FUNCTION public.check_guild_timezone();

CREATE TRIGGER guild_config_set_updated_at BEFORE UPDATE ON public.guild_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER managed_channels_record_update AFTER UPDATE ON public.managed_channels FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('guild_id', 'channel_id');

CREATE TRIGGER setup_drafts_record_update AFTER UPDATE ON public.setup_drafts FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('guild_id');

CREATE TRIGGER managed_channels_set_updated_at BEFORE UPDATE ON public.managed_channels FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER task_reassignments_require_quota BEFORE INSERT ON public.task_reassignments FOR EACH ROW EXECUTE FUNCTION public.enforce_reassignment_quota();

CREATE TRIGGER tasks_record_update AFTER UPDATE ON public.tasks FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*)) EXECUTE FUNCTION history.record_row_version('id');

CREATE TRIGGER tasks_refuse_undelete BEFORE UPDATE OF deleted_at ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.refuse_undelete();

CREATE TRIGGER tasks_require_open_parent BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();

CREATE TRIGGER tasks_require_open_parent_on_update BEFORE UPDATE OF assignee_id, description, due_date, status ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();

CREATE TRIGGER tasks_require_quota BEFORE INSERT ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.enforce_task_quotas();

CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Foreign keys. None cascades, so no delete can take other rows with it. ----------------

ALTER TABLE ONLY public.config_audit
    ADD CONSTRAINT config_audit_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guild_config(guild_id);

ALTER TABLE ONLY public.event_reminder_log
    ADD CONSTRAINT event_reminder_log_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id);

ALTER TABLE ONLY public.event_step_assignees
    ADD CONSTRAINT event_step_assignees_event_id_guild_id_fkey FOREIGN KEY (event_id, guild_id) REFERENCES public.events(id, guild_id);

ALTER TABLE ONLY public.event_steps
    ADD CONSTRAINT event_steps_event_id_guild_id_fkey FOREIGN KEY (event_id, guild_id) REFERENCES public.events(id, guild_id);

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_guild_id_channel_id_fkey FOREIGN KEY (guild_id, channel_id) REFERENCES public.managed_channels(guild_id, channel_id);

ALTER TABLE ONLY public.managed_channels
    ADD CONSTRAINT managed_channels_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guild_config(guild_id);

ALTER TABLE ONLY public.reminder_log
    ADD CONSTRAINT reminder_log_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);

ALTER TABLE ONLY public.task_reassignments
    ADD CONSTRAINT task_reassignments_guild_id_fkey FOREIGN KEY (guild_id) REFERENCES public.guild_config(guild_id);

ALTER TABLE ONLY public.task_reassignments
    ADD CONSTRAINT task_reassignments_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id);

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_event_id_guild_id_fkey FOREIGN KEY (event_id, guild_id) REFERENCES public.events(id, guild_id);

-- The bot's role -----------------------------------------------------------------------

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

-- A bound on anything the bot starts, whatever pooler is in front. The bot gives up on
-- its own side well before this. These are only defaults: a role may change its own
-- settings, so anyone holding a leaked bot_app login can lift them with SET, or with
-- ALTER ROLE bot_app SET for later sessions. They guard against the bot's own mistakes,
-- not against an attacker.
ALTER ROLE bot_app SET statement_timeout = '10s';
ALTER ROLE bot_app SET idle_in_transaction_session_timeout = '15s';
-- The bot reads dates and times as UTC. A guild's own zone is applied by name where it
-- matters, never through the session's.
ALTER ROLE bot_app SET timezone = 'UTC';

GRANT USAGE ON SCHEMA public TO bot_app;

GRANT USAGE ON DOMAIN public.discord_id TO bot_app;
GRANT USAGE ON TYPE
  public.event_reminder_kind,
  public.event_status,
  public.event_step_kind,
  public.job_run_status,
  public.managed_channel_status,
  public.reminder_kind,
  public.reminder_state,
  public.task_status,
  public.thread_status
TO bot_app;

-- The rest is read-only for the bot, so a direct write cannot skip the version checks,
-- audit rows, locks, limits and claim tokens that the functions keep.
GRANT SELECT ON TABLE
  public.config_audit,
  public.event_reminder_log,
  public.event_step_assignees,
  public.event_steps,
  public.events,
  public.guild_config,
  public.job_runs,
  public.managed_channels,
  public.reminder_log,
  public.setup_drafts,
  public.tasks
TO bot_app;

-- The bot writes events and tasks directly. Never DELETE or TRUNCATE: rows are only
-- ever soft-deleted.
GRANT INSERT, UPDATE ON TABLE public.events, public.tasks TO bot_app;

GRANT EXECUTE ON FUNCTION
  public.apply_config_change(text, integer, text, boolean, text[], text[], text),
  public.apply_role_bindings(text, integer, text, text, text, text, text, text, text),
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.begin_job_run(text, integer, timestamptz),
  public.claim_event_post_attempt(uuid, text),
  public.claim_event_reminder(uuid, public.event_reminder_kind, date),
  public.claim_interaction(text),
  public.claim_reminder(uuid, public.reminder_kind, date, text, timestamptz),
  public.claim_step_handoff(uuid, text, public.event_step_kind),
  public.complete_event_step(uuid, text, public.event_step_kind, text),
  public.edit_task(uuid, text, timestamptz, text, date, text, text),
  public.expire_interaction_claims(),
  public.finish_job_run(uuid, timestamptz, jsonb, text),
  public.mark_channel_unavailable(text, text),
  public.mark_event_reminder_sent(uuid, public.event_reminder_kind, date, uuid, text),
  public.mark_event_reminder_skipped(uuid, public.event_reminder_kind, date, uuid),
  public.mark_reminder_sent(uuid, public.reminder_kind, date, uuid, text),
  public.mark_reminder_skipped(uuid, public.reminder_kind, date, uuid),
  public.mark_step_handoff_sent(uuid, text, public.event_step_kind),
  public.reclaim_event_reminder(uuid, public.event_reminder_kind, date, uuid, integer),
  public.reclaim_reminder(uuid, public.reminder_kind, date, uuid, integer, text, timestamptz),
  public.record_reminder_refused(uuid, public.reminder_kind, date, uuid),
  public.release_event_post_attempt(uuid, text),
  public.save_setup_draft(text, text, text, text, text, text, text, text, text),
  public.set_event_pickup_time(uuid, text, time, text),
  public.soft_delete_event(uuid, text),
  public.unassign_event_step(uuid, text, public.event_step_kind, text, text)
TO bot_app;

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
