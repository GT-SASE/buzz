-- migrate:up

-- Two new steps, Engage picture added and Slides, the countdown reminders, and the undo
-- of a finished step. CREATE OR REPLACE keeps each function's owner and grants, and
-- restates SECURITY DEFINER and the empty search_path, which a replacement does not keep.

-- Slides can be marked not needed instead of done. It stays open, so undoing that is
-- clearing these two, and marking it done clears them.
ALTER TABLE public.event_steps
  ADD COLUMN not_needed_at timestamp with time zone,
  ADD COLUMN not_needed_by public.discord_id,
  ADD CONSTRAINT event_steps_not_needed_together
    CHECK ((not_needed_at IS NULL) = (not_needed_by IS NULL)),
  ADD CONSTRAINT event_steps_not_needed_only_open_slides
    CHECK (not_needed_at IS NULL OR (kind = 'slides' AND status = 'open'));

-- Engage picture added is marked by the Marketing role, so nobody is assigned to it.
ALTER TABLE public.event_step_assignees
  DROP CONSTRAINT event_step_assignees_kind_assignable,
  ADD CONSTRAINT event_step_assignees_kind_assignable
    CHECK (kind <> ALL (ARRAY['budget_approved', 'engage_picture']::public.event_step_kind[]));

-- Every event has one row per kind, closed and deleted ones too, so a read of any of
-- them finds every step. New events get theirs from create_event_steps.
INSERT INTO public.event_steps (event_id, guild_id, kind)
SELECT event.id, event.guild_id, kind
FROM public.events AS event
CROSS JOIN unnest(ARRAY['engage_picture', 'slides']::public.event_step_kind[]) AS kind
ON CONFLICT (event_id, kind) DO NOTHING;

-- Adds a person to a step: 'added', or 'needed_again' when that also undid No slides
-- needed, or 'already_on' if they were on it. Raises 22023 for Budget approved, and CF431
-- once the step has its most people: 10, or 15 for Food pickup. A new return type, so the
-- function is made again and its grant restated.
DROP FUNCTION public.assign_event_step(uuid, text, public.event_step_kind, text, text);

CREATE FUNCTION public.assign_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_user_id text, p_actor_id text) RETURNS text
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
    RETURN 'already_on';
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

  -- Someone put on Slides means it is needed after all.
  IF p_kind = 'slides' THEN
    UPDATE public.event_steps
    SET not_needed_at = NULL,
        not_needed_by = NULL
    WHERE event_id = p_event_id AND kind = 'slides' AND not_needed_at IS NOT NULL;
    IF FOUND THEN
      RETURN 'needed_again';
    END IF;
  END IF;

  RETURN 'added';
END;
$$;

-- Marks a step done. Engage picture added waits for Engage post, and raises CF425 until
-- it is done. Slides marked not needed stops being so once it is done.
CREATE OR REPLACE FUNCTION public.complete_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_status public.task_status;
  v_post_status public.task_status;
  v_event public.events%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step cannot be marked done' USING ERRCODE = '22023';
  END IF;

  -- Engage post is locked before the picture, in the order reopen_event_step locks them,
  -- so the two cannot deadlock, and it cannot be reopened until this commits.
  IF p_kind = 'engage_picture' THEN
    SELECT status INTO v_post_status
    FROM public.event_steps
    WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = 'engage_post'
    FOR SHARE;
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

  IF p_kind = 'engage_picture' AND v_post_status IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'engage post is not done' USING ERRCODE = 'CF425';
  END IF;

  UPDATE public.event_steps
  SET status = 'done',
      completed_at = now(),
      completed_by = p_actor_id,
      not_needed_at = NULL,
      not_needed_by = NULL
  WHERE event_id = p_event_id AND kind = p_kind;

  RETURN true;
END;
$$;

-- Undoes a done step. True if this call reopened it, false if it was open. The hand-off
-- record goes with it, so doing the step again sends its message again. Reopening
-- Engage post also reopens Engage picture added, which waits for it. The old row is kept
-- in history.row_versions.
CREATE FUNCTION public.reopen_event_step(p_event_id uuid, p_guild_id text, p_kind public.event_step_kind) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_status public.task_status;
  v_event public.events%ROWTYPE;
BEGIN
  IF p_kind IS NULL OR p_kind = 'food_pickup' THEN
    RAISE EXCEPTION 'this step cannot be reopened' USING ERRCODE = '22023';
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

  IF v_status <> 'done' THEN
    RETURN false;
  END IF;

  UPDATE public.event_steps
  SET status = 'open',
      completed_at = NULL,
      completed_by = NULL,
      handoff_claimed_at = NULL,
      handoff_sent_at = NULL
  WHERE event_id = p_event_id
    AND (kind = p_kind OR (p_kind = 'engage_post' AND kind = 'engage_picture'))
    AND status = 'done';

  RETURN true;
END;
$$;

-- Marks Slides not needed, or undoes that. True if this call changed it, false if it was
-- already so, or is done.
CREATE FUNCTION public.set_slides_not_needed(p_event_id uuid, p_guild_id text, p_not_needed boolean, p_actor_id text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
  v_step public.event_steps%ROWTYPE;
  v_event public.events%ROWTYPE;
BEGIN
  IF p_not_needed IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'a choice and an actor are needed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_step
  FROM public.event_steps
  WHERE event_id = p_event_id AND guild_id = p_guild_id AND kind = 'slides'
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

  IF v_step.status <> 'open' OR (v_step.not_needed_at IS NOT NULL) = p_not_needed THEN
    RETURN false;
  END IF;

  UPDATE public.event_steps
  SET not_needed_at = CASE WHEN p_not_needed THEN now() END,
      not_needed_by = CASE WHEN p_not_needed THEN p_actor_id END
  WHERE event_id = p_event_id AND kind = 'slides';

  RETURN true;
END;
$$;

-- Lets the new kinds through. A pickup reminder still needs Food pickup set up. Which day
-- each kind goes out is the planner's to decide.
CREATE OR REPLACE FUNCTION public.event_reminder_allowed(p_event_id uuid, p_kind public.event_reminder_kind, p_reminder_date date) RETURNS boolean
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
      -- neither a day long gone nor one still to come.
      AND p_reminder_date <= event.event_date
      AND p_reminder_date >= (pg_catalog.now() AT TIME ZONE config.timezone)::date - 1
      AND p_reminder_date <= (pg_catalog.now() AT TIME ZONE config.timezone)::date
      AND (
        p_kind NOT IN ('pickup_before', 'pickup_day')
        OR EXISTS (
          SELECT 1 FROM public.event_steps AS step
          WHERE step.event_id = event.id AND step.kind = 'food_pickup' AND step.status = 'done'
        )
      )
  );
$$;

GRANT EXECUTE ON FUNCTION
  public.assign_event_step(uuid, text, public.event_step_kind, text, text),
  public.reopen_event_step(uuid, text, public.event_step_kind),
  public.set_slides_not_needed(uuid, text, boolean, text)
TO bot_app;

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
