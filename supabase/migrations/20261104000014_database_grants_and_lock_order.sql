-- Narrows what the bot's role can write directly, and settles the order of two locks.

-- Finishes a run under the job's lock, so a begin_job_run in progress either sees this
-- success or runs before it, and cannot read the slot just before the commit and find no
-- running row just after. The function reads the job's name itself, so the caller cannot
-- take the wrong lock.
--
-- Returns a JSON array of the finished row, or an empty one if the run is unknown or has
-- already finished. The bot's clock sets the finish time, but never later than the
-- database's.
CREATE FUNCTION public.finish_job_run(
  p_id uuid,
  p_finished_at timestamptz,
  p_results jsonb,
  p_error text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

REVOKE ALL ON FUNCTION public.finish_job_run(uuid, timestamptz, jsonb, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.finish_job_run(uuid, timestamptz, jsonb, text)
TO service_role;

-- The bot's role never needed a direct write to this table: begin_job_run inserts and
-- finish_job_run updates. Without one, a leaked key cannot add a run dated in the future,
-- which would have held the slot shut for good, or rewrite the times of a past run.
REVOKE INSERT, UPDATE ON TABLE public.job_runs FROM service_role;

-- No writer, the owner included, may set a time that has not happened yet. A time already
-- on the row is left alone, so that begin_job_run can still close such a row.
CREATE FUNCTION public.refuse_future_job_run_times() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF (NEW.started_at > clock_timestamp() AND NEW.started_at IS DISTINCT FROM OLD.started_at)
    OR (NEW.heartbeat_at > clock_timestamp() AND NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at)
    OR (NEW.finished_at > clock_timestamp() AND NEW.finished_at IS DISTINCT FROM OLD.finished_at)
  THEN
    RAISE EXCEPTION 'job run time is in the future' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_future_job_run_times()
FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER job_runs_refuse_future_times BEFORE INSERT OR UPDATE ON public.job_runs
  FOR EACH ROW EXECUTE FUNCTION public.refuse_future_job_run_times();

-- As before, with two changes. A row dated in the future, which a backup or an earlier
-- leak could hold, no longer counts: a success so dated does not close the slot, and a
-- running row so dated is closed as abandoned. Neither can stop reminders any more.
--
-- The other change is a limit on the wait for the job's lock. Any role that can log in can
-- take an advisory lock, and the backup role can log in. A session holding this one would
-- otherwise stall every run until the bot's request gave up. After 3 seconds, which is
-- less than the bot's limit on a database call, this fails with SQLSTATE 55P03 and the
-- run is reported as failed.
--
-- The limit is set in the body because a function's SET clause here holds only the empty
-- search_path. It lasts until the transaction ends, which behind PostgREST is this call.
CREATE OR REPLACE FUNCTION public.begin_job_run(
  p_job_name text,
  p_stale_after_seconds integer
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
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
      AND started_at >= date_trunc('day', now() - interval '14 hours', 'UTC') + interval '14 hours'
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

-- New events and tasks can set only the columns the bot sends. Left out on purpose: the
-- timestamps, which the task quota counts by and a forged date would dodge or turn against
-- another officer, post_attempt_at, which could keep an event from ever being posted, and
-- the status and soft delete columns, which a new row has no reason to set.
REVOKE INSERT ON TABLE public.events, public.tasks FROM service_role;
GRANT INSERT (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
  ON TABLE public.events TO service_role;
GRANT INSERT (event_id, guild_id, assignee_id, description, due_date, created_by)
  ON TABLE public.tasks TO service_role;

-- A task update locks the task's row and then its guard asks for the event FOR SHARE, so
-- the order is task, then event. This function used to lock the event and then the tasks,
-- so the two could wait on each other until Postgres cancelled one. It now locks the tasks
-- it can see first, in a fixed order, and only then the event.
--
-- The event's update still comes before the tasks' update. That waits for any insert
-- holding the event FOR SHARE, and the last statement then sees the task that insert
-- committed. Such a task was not locked first, so if a task inserted in that moment is
-- also being updated in that moment, the two can still deadlock. Each side rolls back
-- whole, and that needs three requests inside a few milliseconds.
CREATE OR REPLACE FUNCTION public.soft_delete_event(p_event_id uuid, p_guild_id text) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

-- Migration 2 says this trigger function refuses new work under a removed channel. That
-- holds for events only. A task may be added to an event in a removed channel, on purpose:
-- it is kept, and has no reminders until the channel is added back.
COMMENT ON FUNCTION public.require_open_parent() IS
  'Refuses a new event in a removed channel, and a new or changed task on a closed or '
  'deleted event. A task on an event in a removed channel is allowed: it is kept, and has '
  'no reminders until the channel is added back.';

-- The backup role reads tables and nothing more, but every role gets temp tables and the
-- large-object functions through PUBLIC, and they let it store data despite its read-only
-- grants. Nothing in this project uses either. A role that does not own these objects
-- cannot take them away, and a hosted platform may keep them, so a refusal is not a
-- failure here. The name is fixed because a migration may not use dynamic SQL, and it is
-- the hosted database's name.
DO $$
BEGIN
  REVOKE TEMP ON DATABASE postgres FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege OR invalid_catalog_name THEN
  RAISE NOTICE 'temp tables stay open to PUBLIC on this platform';
END;
$$;

DO $$
BEGIN
  REVOKE EXECUTE ON FUNCTION
    pg_catalog.lo_creat(integer),
    pg_catalog.lo_create(oid),
    pg_catalog.lo_from_bytea(oid, bytea),
    pg_catalog.lo_put(oid, bigint, bytea),
    pg_catalog.lo_truncate(integer, integer),
    pg_catalog.lo_truncate64(integer, bigint),
    pg_catalog.lo_unlink(oid),
    pg_catalog.lowrite(integer, bytea)
  FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'large-object functions stay open to PUBLIC on this platform';
END;
$$;
