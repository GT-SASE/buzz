-- migrate:up

-- Engage picture late goes out a week after Engage post was done, which can be after the
-- event, so it is the one kind that may be claimed for a day past the event's date. The
-- rule lives in one function, which the closer of a stale claim reads as well, so a ping
-- that may still go out is not closed as skipped. A new function starts open to PUBLIC by
-- Postgres default, so it is revoked, and only other functions call it.
CREATE FUNCTION discord_bot.event_reminder_day_open(p_kind discord_bot.event_reminder_kind, p_reminder_date date, p_event_date date) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    SET search_path TO ''
    AS $$
  SELECT p_kind = 'engage_picture_late' OR p_reminder_date <= p_event_date;
$$;

REVOKE ALL ON FUNCTION discord_bot.event_reminder_day_open(discord_bot.event_reminder_kind, date, date) FROM PUBLIC;

-- CREATE OR REPLACE keeps the function's owner and grants, and restates the empty
-- search_path, which a replacement does not keep.
CREATE OR REPLACE FUNCTION discord_bot.event_reminder_allowed(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO ''
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM discord_bot.events AS event
    JOIN discord_bot.managed_channels AS channel
      ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
    JOIN discord_bot.guild_config AS config
      ON config.guild_id = event.guild_id
    WHERE event.id = p_event_id
      AND event.status = 'active'
      AND event.deleted_at IS NULL
      AND channel.status = 'active'
      AND config.reminders_enabled
      -- Up to the event, unless the kind goes out after it, and today or yesterday in the
      -- guild's zone, so a run can claim neither a day long gone nor one still to come.
      AND discord_bot.event_reminder_day_open(p_kind, p_reminder_date, event.event_date)
      AND p_reminder_date >= (pg_catalog.now() AT TIME ZONE config.timezone)::date - 1
      AND p_reminder_date <= (pg_catalog.now() AT TIME ZONE config.timezone)::date
      AND (
        p_kind NOT IN ('pickup_before', 'pickup_day')
        OR EXISTS (
          SELECT 1 FROM discord_bot.event_steps AS step
          WHERE step.event_id = event.id AND step.kind = 'food_pickup' AND step.status = 'done'
        )
      )
  );
$$;

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
