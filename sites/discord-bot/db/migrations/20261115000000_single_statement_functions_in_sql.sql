-- migrate:up

-- Each function here is one statement, so it needs no PL/pgSQL. CREATE OR REPLACE keeps
-- the owner and the grants. SECURITY DEFINER and the empty search_path are restated
-- because a replacement takes only the attributes it names. A data-modifying CTE always
-- runs to completion, so `EXISTS` over its RETURNING rows is what FOUND was.

CREATE OR REPLACE FUNCTION discord_bot.claim_interaction(p_interaction_id text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH claimed AS (
    INSERT INTO discord_bot.interaction_claims (interaction_id)
    VALUES (p_interaction_id)
    ON CONFLICT (interaction_id) DO NOTHING
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM claimed);
$$;

CREATE OR REPLACE FUNCTION discord_bot.expire_interaction_claims() RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH deleted AS (
    DELETE FROM discord_bot.interaction_claims
    WHERE claimed_at < now() - interval '1 day'
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;

CREATE OR REPLACE FUNCTION discord_bot.claim_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH claimed AS (
    UPDATE discord_bot.events
    SET post_attempt_at = now()
    WHERE id = p_event_id
      AND guild_id = p_guild_id
      AND deleted_at IS NULL
      AND thread_status = 'pending'
      AND post_attempt_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM claimed);
$$;

CREATE OR REPLACE FUNCTION discord_bot.release_event_post_attempt(p_event_id uuid, p_guild_id text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH released AS (
    UPDATE discord_bot.events
    SET post_attempt_at = NULL
    WHERE id = p_event_id
      AND guild_id = p_guild_id
      AND deleted_at IS NULL
      AND thread_status = 'pending'
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM released);
$$;

CREATE OR REPLACE FUNCTION discord_bot.claim_event_reminder(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  INSERT INTO discord_bot.event_reminder_log (event_id, kind, reminder_date)
  SELECT p_event_id, p_kind, p_reminder_date
  WHERE discord_bot.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  ON CONFLICT (event_id, kind, reminder_date) DO NOTHING
  RETURNING claim_token;
$$;

CREATE OR REPLACE FUNCTION discord_bot.reclaim_event_reminder(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date, p_claim_token uuid, p_stale_after_seconds integer) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  UPDATE discord_bot.event_reminder_log AS log
  SET claim_token = gen_random_uuid(),
      claimed_at = now(),
      attempts = log.attempts + 1
  WHERE log.event_id = p_event_id
    AND log.kind = p_kind
    AND log.reminder_date = p_reminder_date
    AND log.state = 'claimed'
    AND log.claim_token = p_claim_token
    AND log.claimed_at < now() - make_interval(secs => p_stale_after_seconds)
    AND discord_bot.event_reminder_allowed(p_event_id, p_kind, p_reminder_date)
  RETURNING log.claim_token;
$$;

CREATE OR REPLACE FUNCTION discord_bot.mark_event_reminder_sent(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date, p_claim_token uuid, p_message_id text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH marked AS (
    UPDATE discord_bot.event_reminder_log
    SET state = 'sent',
        sent_at = now(),
        message_id = p_message_id
    WHERE event_id = p_event_id
      AND kind = p_kind
      AND reminder_date = p_reminder_date
      AND state = 'claimed'
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM marked);
$$;

CREATE OR REPLACE FUNCTION discord_bot.mark_event_reminder_skipped(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH marked AS (
    UPDATE discord_bot.event_reminder_log
    SET state = 'skipped'
    WHERE event_id = p_event_id
      AND kind = p_kind
      AND reminder_date = p_reminder_date
      AND state = 'claimed'
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM marked);
$$;

CREATE OR REPLACE FUNCTION discord_bot.mark_reminder_sent(p_task_id uuid, p_kind discord_bot.reminder_kind, p_due_date date, p_claim_token uuid, p_message_id text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH marked AS (
    UPDATE discord_bot.reminder_log
    SET state = 'sent',
        sent_at = now(),
        message_id = p_message_id
    WHERE task_id = p_task_id
      AND kind = p_kind
      AND due_date = p_due_date
      AND state = 'claimed'
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM marked);
$$;

CREATE OR REPLACE FUNCTION discord_bot.mark_reminder_skipped(p_task_id uuid, p_kind discord_bot.reminder_kind, p_due_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH marked AS (
    UPDATE discord_bot.reminder_log
    SET state = 'skipped'
    WHERE task_id = p_task_id
      AND kind = p_kind
      AND due_date = p_due_date
      AND state = 'claimed'
      AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM marked);
$$;

CREATE OR REPLACE FUNCTION discord_bot.record_reminder_refused(p_task_id uuid, p_kind discord_bot.reminder_kind, p_due_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH recorded AS (
    UPDATE discord_bot.reminder_log
    SET refused_attempts = refused_attempts + 1
    WHERE task_id = p_task_id
      AND kind = p_kind
      AND due_date = p_due_date
      AND state = 'claimed'
      AND claim_token = p_claim_token
      AND refused_attempts < attempts
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM recorded);
$$;

CREATE OR REPLACE FUNCTION discord_bot.mark_step_handoff_sent(p_event_id uuid, p_guild_id text, p_kind discord_bot.event_step_kind) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH marked AS (
    UPDATE discord_bot.event_steps
    SET handoff_sent_at = now()
    WHERE event_id = p_event_id
      AND guild_id = p_guild_id
      AND kind = p_kind
      AND handoff_claimed_at IS NOT NULL
      AND handoff_sent_at IS NULL
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM marked);
$$;

CREATE OR REPLACE FUNCTION discord_bot.save_setup_draft(p_guild_id text, p_actor_id text, p_officer_role_id text, p_admin_role_id text, p_eboard_role_id text, p_events_committee_role_id text, p_treasury_role_id text, p_marketing_role_id text, p_fingerprint text) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  INSERT INTO discord_bot.setup_drafts (
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
      created_at = now()
  RETURNING true;
$$;

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
