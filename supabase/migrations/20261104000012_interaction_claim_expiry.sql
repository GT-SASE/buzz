-- Deletes the interaction claims that have outlived their use: a token lasts 15 minutes,
-- so a day is well past the last replay that could matter. The bot's role has no access to
-- this table, so this is its only way to clear it. Returns how many rows went.
CREATE FUNCTION public.expire_interaction_claims() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
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

REVOKE ALL ON FUNCTION public.expire_interaction_claims() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.expire_interaction_claims() TO service_role;
