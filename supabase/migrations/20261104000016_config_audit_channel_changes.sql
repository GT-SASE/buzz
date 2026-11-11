-- The audit row of a config change now says which forums it added and removed. Before,
-- it held only the active forums, so removing a forum that was already unavailable left
-- identical old and new values and no record of which forum went. The arguments are
-- unchanged, so the function keeps its grants.
CREATE OR REPLACE FUNCTION public.apply_config_change(
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
  v_added_ids jsonb;
  v_removed_ids jsonb;
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

  SELECT coalesce(jsonb_agg(DISTINCT channel_id ORDER BY channel_id), '[]') INTO v_added_ids
  FROM unnest(v_add) AS channel_id
  WHERE NOT v_old_channels ? channel_id;

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

  SELECT coalesce(jsonb_agg(DISTINCT channel_id ORDER BY channel_id), '[]') INTO v_removed_ids
  FROM unnest(v_remove) AS channel_id;

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
      'active_channel_ids', v_new_channels,
      'added_channel_ids', v_added_ids,
      'removed_channel_ids', v_removed_ids
    ),
    v_version
  );

  RETURN v_version;
END;
$$;
