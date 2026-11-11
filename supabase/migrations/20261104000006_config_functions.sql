-- Config writes. Each function checks the caller's expected version, applies the
-- change, bumps the version and writes the audit row in one transaction, so two
-- open panels cannot overwrite each other.
--
-- A stale version raises SQLSTATE CF409, which callers should treat as "reload
-- and try again". A guild with no config row has version 0.
--
-- These are SECURITY DEFINER because the bot's role has no write access to the
-- config tables, which is what makes these functions the only way it can change
-- them. Two kinds of write are not audited: mark_channel_unavailable, which records
-- what the health check saw rather than an admin's decision, and anything done
-- directly by the owning role, such as in the Supabase SQL editor.

-- Role bindings are kept apart from other settings because they decide who holds
-- which access level and are restricted to Discord Administrators.
CREATE FUNCTION public.apply_role_bindings(
  p_guild_id text,
  p_expected_version integer,
  p_actor_id text,
  p_officer_role_id text,
  p_admin_role_id text
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_current public.guild_config%ROWTYPE;
  v_old_values jsonb;
  v_version integer;
BEGIN
  SELECT * INTO v_current
  FROM public.guild_config
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_current.version IS DISTINCT FROM p_expected_version THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    v_old_values := jsonb_build_object(
      'officer_role_id', v_current.officer_role_id,
      'admin_role_id', v_current.admin_role_id
    );

    UPDATE public.guild_config
    SET officer_role_id = p_officer_role_id,
        admin_role_id = p_admin_role_id,
        version = version + 1
    WHERE guild_id = p_guild_id
    RETURNING version INTO v_version;
  ELSE
    IF p_expected_version IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;

    -- A concurrent first setup can pass the check above. The conflict leaves
    -- v_version null, which is reported as a stale version.
    INSERT INTO public.guild_config (guild_id, officer_role_id, admin_role_id)
    VALUES (p_guild_id, p_officer_role_id, p_admin_role_id)
    ON CONFLICT (guild_id) DO NOTHING
    RETURNING version INTO v_version;

    IF v_version IS NULL THEN
      RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
    END IF;
  END IF;

  INSERT INTO public.config_audit (guild_id, actor_id, action, old_values, new_values, version_after)
  VALUES (
    p_guild_id,
    p_actor_id,
    'role_bindings',
    v_old_values,
    jsonb_build_object('officer_role_id', p_officer_role_id, 'admin_role_id', p_admin_role_id),
    v_version
  );

  RETURN v_version;
END;
$$;

-- Managed forums, the reminder switch and the timezone. NULL or an empty array
-- leaves that setting alone. Removing a channel keeps its row and its events.
CREATE FUNCTION public.apply_config_change(
  p_guild_id text,
  p_expected_version integer,
  p_actor_id text,
  p_reminders_enabled boolean DEFAULT NULL,
  p_add_channel_ids text[] DEFAULT '{}',
  p_remove_channel_ids text[] DEFAULT '{}',
  p_timezone text DEFAULT NULL
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_add text[] := coalesce(p_add_channel_ids, '{}');
  v_remove text[] := coalesce(p_remove_channel_ids, '{}');
  v_current public.guild_config%ROWTYPE;
  v_old_channels jsonb;
  v_new_channels jsonb;
  v_reminders boolean;
  v_timezone text;
  v_version integer;
  v_removed integer;
BEGIN
  IF p_reminders_enabled IS NULL
    AND p_timezone IS NULL
    AND cardinality(v_add) = 0
    AND cardinality(v_remove) = 0
  THEN
    RAISE EXCEPTION 'no config change given' USING ERRCODE = '22023';
  END IF;

  -- 25 is the most a Discord select menu can submit at once.
  IF cardinality(v_add) > 25 OR cardinality(v_remove) > 25 THEN
    RAISE EXCEPTION 'too many channels in one change' USING ERRCODE = '22023';
  END IF;

  IF array_position(v_add, NULL) IS NOT NULL OR array_position(v_remove, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'channel IDs cannot be null' USING ERRCODE = '22023';
  END IF;

  IF v_add && v_remove THEN
    RAISE EXCEPTION 'a channel cannot be both added and removed' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_current
  FROM public.guild_config
  WHERE guild_id = p_guild_id
  FOR UPDATE;

  IF NOT FOUND OR v_current.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'config version is stale' USING ERRCODE = 'CF409';
  END IF;

  SELECT coalesce(jsonb_agg(channel_id ORDER BY channel_id), '[]') INTO v_old_channels
  FROM public.managed_channels
  WHERE guild_id = p_guild_id AND status = 'active';

  INSERT INTO public.managed_channels (guild_id, channel_id)
  SELECT DISTINCT p_guild_id, channel_id
  FROM unnest(v_add) AS channel_id
  ON CONFLICT (guild_id, channel_id) DO UPDATE SET status = 'active';

  UPDATE public.managed_channels
  SET status = 'removed'
  WHERE guild_id = p_guild_id
    AND channel_id = ANY (v_remove)
    AND status <> 'removed';
  GET DIAGNOSTICS v_removed = ROW_COUNT;

  IF v_removed <> (SELECT count(DISTINCT channel_id) FROM unnest(v_remove) AS channel_id) THEN
    RAISE EXCEPTION 'channel to remove is not managed' USING ERRCODE = '22023';
  END IF;

  SELECT coalesce(jsonb_agg(channel_id ORDER BY channel_id), '[]') INTO v_new_channels
  FROM public.managed_channels
  WHERE guild_id = p_guild_id AND status = 'active';

  UPDATE public.guild_config
  SET reminders_enabled = coalesce(p_reminders_enabled, reminders_enabled),
      timezone = coalesce(p_timezone, timezone),
      version = version + 1
  WHERE guild_id = p_guild_id
  RETURNING version, reminders_enabled, timezone INTO v_version, v_reminders, v_timezone;

  INSERT INTO public.config_audit (guild_id, actor_id, action, old_values, new_values, version_after)
  VALUES (
    p_guild_id,
    p_actor_id,
    'settings',
    jsonb_build_object(
      'reminders_enabled', v_current.reminders_enabled,
      'timezone', v_current.timezone,
      'active_channel_ids', v_old_channels
    ),
    jsonb_build_object(
      'reminders_enabled', v_reminders,
      'timezone', v_timezone,
      'active_channel_ids', v_new_channels
    ),
    v_version
  );

  RETURN v_version;
END;
$$;

-- For the health check, when Discord says a channel is gone. It changes no admin
-- setting, so it neither bumps the version nor writes an audit row, and an open
-- panel stays valid. Each call is recorded in job_runs instead, whether or not it
-- changed anything. Returns false if the channel was not active. An admin brings the
-- channel back by adding it again.
CREATE FUNCTION public.mark_channel_unavailable(p_guild_id text, p_channel_id text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_changed boolean;
BEGIN
  UPDATE public.managed_channels
  SET status = 'unavailable'
  WHERE guild_id = p_guild_id AND channel_id = p_channel_id AND status = 'active';
  v_changed := FOUND;

  INSERT INTO public.job_runs (job_name, status, finished_at, results)
  VALUES (
    'mark_channel_unavailable',
    'succeeded',
    now(),
    jsonb_build_object('guild_id', p_guild_id, 'channel_id', p_channel_id, 'changed', v_changed)
  );

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION
  public.apply_role_bindings(text, integer, text, text, text),
  public.apply_config_change(text, integer, text, boolean, text[], text[], text),
  public.mark_channel_unavailable(text, text)
FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
  public.apply_role_bindings(text, integer, text, text, text),
  public.apply_config_change(text, integer, text, boolean, text[], text[], text),
  public.mark_channel_unavailable(text, text)
TO service_role;
