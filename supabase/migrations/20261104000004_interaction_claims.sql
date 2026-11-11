-- Lets a mutating handler run once per Discord interaction, even if the request is
-- delivered or retried more than once.
--
-- Retention: an interaction's token lasts 15 minutes, after which Discord can no
-- longer be answered for it, so a row is only useful for about that long. Rows older
-- than one day may be deleted. Rows are small, so that job can come later. The bot's
-- role has no access to this table, so the job will need a role or function of its own.

CREATE TABLE public.interaction_claims (
  interaction_id public.discord_id PRIMARY KEY,
  claimed_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.interaction_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.interaction_claims FROM PUBLIC, anon, authenticated, service_role;

-- Returns true for the first caller with this ID, and false for every later one. The
-- unique insert makes that atomic, and a concurrent caller waits for the first to
-- finish. A handler that fails after claiming is not retried, so claim in the same
-- transaction as the change when a retry should be possible.
CREATE FUNCTION public.claim_interaction(p_interaction_id text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.interaction_claims (interaction_id)
  VALUES (p_interaction_id)
  ON CONFLICT (interaction_id) DO NOTHING;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_interaction(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_interaction(text) TO service_role;
