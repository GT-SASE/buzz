-- Lets one run of a job start at a time, and one succeed per schedule slot. Vercel can
-- deliver a cron invocation twice, and whoever holds the secret can call the endpoint
-- at will, so a run's send cap only means something if a second run cannot pick up
-- where the first one stopped.

-- The backstop: however a row gets written, a job has at most one running row.
CREATE UNIQUE INDEX job_runs_one_running_idx ON public.job_runs (job_name)
  WHERE status = 'running';

-- Returns the new run's ID, or NULL if the job may not start now.
--
-- A 'running' row whose heartbeat is older than p_stale_after_seconds came from a run
-- the platform killed, so it is closed as failed.
--
-- A slot starts at 14:00 UTC each day, the time of the first cron. A run that succeeded
-- in the current slot refuses later ones until the next slot, so the 16:00 cron does
-- nothing after a good morning. A failed run does not hold the job back, so the 16:00
-- cron recovers a failed morning. The three-argument date_trunc keeps this in UTC
-- whatever the session's time zone is.
--
-- The lock is transaction-scoped, so it is safe behind a transaction-mode pooler. It
-- lasts only for this call. What keeps a second run out for the rest of the first
-- one's life is the 'running' row.
CREATE FUNCTION public.begin_job_run(
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
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('job_runs:' || p_job_name, 0)
  );

  UPDATE public.job_runs
  SET status = 'failed',
      finished_at = now(),
      error = 'abandoned'
  WHERE job_name = p_job_name
    AND status = 'running'
    AND heartbeat_at < now() - make_interval(secs => p_stale_after_seconds);

  IF EXISTS (
    SELECT 1
    FROM public.job_runs
    WHERE job_name = p_job_name
      AND status = 'succeeded'
      AND started_at >= date_trunc('day', now() - interval '14 hours', 'UTC') + interval '14 hours'
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

REVOKE ALL ON FUNCTION public.begin_job_run(text, integer)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.begin_job_run(text, integer)
TO service_role;
