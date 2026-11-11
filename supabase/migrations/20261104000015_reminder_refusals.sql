-- What a reminder run needs to remember about sends Discord refused.

-- How many of a reminder's attempts are known not to have reached anyone. `attempts` counts
-- every claim, and a crash or a 5xx may have delivered the message, so only the difference
-- says how many times someone may already have been notified.
ALTER TABLE public.reminder_log
  ADD COLUMN refused_attempts integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT reminder_log_refused_attempts_range
    CHECK (refused_attempts BETWEEN 0 AND attempts);

-- How many runs in a row an event's thread has refused the bot. It belongs to the event and
-- not to a reminder, because a thread that stays blocked must stay held as a task moves on
-- from one kind of reminder to the next. A send that lands sets it back to 0.
ALTER TABLE public.events
  ADD COLUMN thread_refusals integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT events_thread_refusals_not_negative CHECK (thread_refusals >= 0);

-- Records that this claim's send is known not to have been delivered. False if the token no
-- longer holds the claim, or this attempt has been recorded already.
CREATE FUNCTION public.record_reminder_refused(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date,
  p_claim_token uuid
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

-- Returns the count after this refusal, or NULL if there is no such live event.
CREATE FUNCTION public.record_thread_refusal(
  p_event_id uuid,
  p_guild_id text
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE public.events
  SET thread_refusals = thread_refusals + 1
  WHERE id = p_event_id
    AND guild_id = p_guild_id
    AND deleted_at IS NULL
  RETURNING thread_refusals INTO v_count;
  RETURN v_count;
END;
$$;

-- False if the count was already 0 or there is no such live event.
CREATE FUNCTION public.clear_thread_refusals(
  p_event_id uuid,
  p_guild_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.events
  SET thread_refusals = 0
  WHERE id = p_event_id
    AND guild_id = p_guild_id
    AND deleted_at IS NULL
    AND thread_refusals > 0;
  RETURN FOUND;
END;
$$;

-- A run renders from what it read earlier. A caller that names the assignee and version it
-- read is refused with SQLSTATE CF412 if the task has since changed, so an edit made during
-- a run cannot send the old text to the old assignee. The run then leaves the slot open and
-- the next run reads the task again. A caller that names neither gets the old behaviour,
-- which suits a claim that sends nothing.
--
-- Both are otherwise as in 20261104000007_reminder_claim_guards.sql.
DROP FUNCTION public.claim_reminder(uuid, public.reminder_kind, date);
DROP FUNCTION public.reclaim_reminder(uuid, public.reminder_kind, date, uuid);

CREATE FUNCTION public.claim_reminder(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date,
  p_assignee_id text DEFAULT NULL,
  p_updated_at timestamptz DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

CREATE FUNCTION public.reclaim_reminder(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date,
  p_claim_token uuid,
  p_assignee_id text DEFAULT NULL,
  p_updated_at timestamptz DEFAULT NULL
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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
    AND log.claimed_at < now() - interval '1 hour'
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

REVOKE ALL ON FUNCTION
  public.claim_reminder(uuid, public.reminder_kind, date, text, timestamptz),
  public.reclaim_reminder(uuid, public.reminder_kind, date, uuid, text, timestamptz),
  public.record_reminder_refused(uuid, public.reminder_kind, date, uuid),
  public.record_thread_refusal(uuid, text),
  public.clear_thread_refusals(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_reminder(uuid, public.reminder_kind, date, text, timestamptz),
  public.reclaim_reminder(uuid, public.reminder_kind, date, uuid, text, timestamptz),
  public.record_reminder_refused(uuid, public.reminder_kind, date, uuid),
  public.record_thread_refusal(uuid, text),
  public.clear_thread_refusals(uuid, text)
TO service_role;
