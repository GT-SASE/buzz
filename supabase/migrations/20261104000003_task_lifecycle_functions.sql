-- Soft deletes and the reminder claim cycle. These are SECURITY DEFINER because the
-- bot's role cannot write these columns directly, which is what makes these functions
-- the only way for it to soft-delete an event or change a reminder's state.

-- Soft-deletes an event and its tasks in one transaction. Returns the number of
-- tasks deleted, or NULL if there is no live event with that ID in that guild.
--
-- The event is updated first. That waits for any insert holding the event FOR SHARE,
-- and the next statement then sees the task that insert committed.
CREATE FUNCTION public.soft_delete_event(p_event_id uuid, p_guild_id text) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_deleted integer;
BEGIN
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

-- Takes the claim for one reminder and returns its token. Returns NULL if someone
-- else holds it, or if the task is no longer open with that due date, so a run
-- working from an out-of-date read sends nothing.
CREATE FUNCTION public.claim_reminder(
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
  SELECT id, p_kind, due_date
  FROM public.tasks
  WHERE id = p_task_id
    AND due_date = p_due_date
    AND status = 'open'
    AND deleted_at IS NULL
  ON CONFLICT (task_id, kind, due_date) DO NOTHING
  RETURNING claim_token INTO v_token;

  RETURN v_token;
END;
$$;

-- Takes over a claim left unfinished for over an hour, given the token last seen on
-- it. Returns a new token, or NULL if the claim is fresh, finished or already taken
-- over, or if the task has moved on. Of two runs retrying one claim, only one wins.
CREATE FUNCTION public.reclaim_reminder(
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
      SELECT 1 FROM public.tasks AS task
      WHERE task.id = p_task_id
        AND task.due_date = p_due_date
        AND task.status = 'open'
        AND task.deleted_at IS NULL
    )
  RETURNING log.claim_token INTO v_token;

  RETURN v_token;
END;
$$;

-- Records a sent reminder. Returns false if the token no longer holds the claim.
CREATE FUNCTION public.mark_reminder_sent(
  p_task_id uuid,
  p_kind public.reminder_kind,
  p_due_date date,
  p_claim_token uuid,
  p_message_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

-- Records a reminder deliberately not sent, such as an older one after a missed run.
-- The caller claims it first, so a skip cannot overwrite a send in progress. Returns
-- false if the token no longer holds the claim.
CREATE FUNCTION public.mark_reminder_skipped(
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
  SET state = 'skipped'
  WHERE task_id = p_task_id
    AND kind = p_kind
    AND due_date = p_due_date
    AND state = 'claimed'
    AND claim_token = p_claim_token;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION
  public.soft_delete_event(uuid, text),
  public.claim_reminder(uuid, public.reminder_kind, date),
  public.reclaim_reminder(uuid, public.reminder_kind, date, uuid),
  public.mark_reminder_sent(uuid, public.reminder_kind, date, uuid, text),
  public.mark_reminder_skipped(uuid, public.reminder_kind, date, uuid)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.soft_delete_event(uuid, text),
  public.claim_reminder(uuid, public.reminder_kind, date),
  public.reclaim_reminder(uuid, public.reminder_kind, date, uuid),
  public.mark_reminder_sent(uuid, public.reminder_kind, date, uuid, text),
  public.mark_reminder_skipped(uuid, public.reminder_kind, date, uuid)
TO service_role;
