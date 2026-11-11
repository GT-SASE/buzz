-- A reminder claim now checks everything the reminder run's query checks, so turning
-- reminders off, closing or deleting an event, or removing a channel stops a run
-- already in progress at its next claim. A run works from a list it read earlier, and
-- that list can be out of date by the time it reaches a task.
--
-- CREATE OR REPLACE keeps the grants from 20261104000003_task_lifecycle_functions.sql.

CREATE OR REPLACE FUNCTION public.claim_reminder(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
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

CREATE OR REPLACE FUNCTION public.reclaim_reminder(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date,
  p_claim_token uuid
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_token uuid;
BEGIN
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
