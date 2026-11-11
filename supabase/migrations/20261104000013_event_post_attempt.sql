-- Two retries of one pending event must not both create a forum post. The first takes
-- this mark before it posts, and the mark lapses by itself, so a crash cannot leave the
-- event stuck. These are functions so that the time comes from the database's clock,
-- and the bot's role is not granted the column.

ALTER TABLE public.events ADD COLUMN post_attempt_at timestamptz;

-- True if the caller may post now. False if the event is not pending, or if another
-- attempt began in the last 60 seconds.
CREATE FUNCTION public.claim_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  UPDATE public.events
  SET post_attempt_at = now()
  WHERE id = p_event_id
    AND guild_id = p_guild_id
    AND deleted_at IS NULL
    AND thread_status = 'pending'
    AND (post_attempt_at IS NULL OR post_attempt_at < now() - interval '60 seconds');

  RETURN FOUND;
END;
$$;

-- For an attempt that Discord clearly refused, so no post exists and a retry need not
-- wait. Never call this after an unclear failure: the post may exist.
CREATE FUNCTION public.release_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

REVOKE ALL ON FUNCTION
  public.claim_event_post_attempt(uuid, text),
  public.release_event_post_attempt(uuid, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_event_post_attempt(uuid, text),
  public.release_event_post_attempt(uuid, text)
TO service_role;
