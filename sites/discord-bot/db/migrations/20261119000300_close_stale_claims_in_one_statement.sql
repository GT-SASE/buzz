-- migrate:up

-- Closing a stale claim read the claim, then its task or event, then marked it skipped,
-- so a task reopened or an event restored in between had its claim closed anyway. Each
-- function now decides and writes in one statement. A new function starts open to PUBLIC
-- by Postgres default, so each is revoked and then granted to bot_app.
CREATE FUNCTION discord_bot.close_stale_reminder(p_task_id uuid, p_kind discord_bot.reminder_kind, p_due_date date, p_claim_token uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH closed AS (
    UPDATE discord_bot.reminder_log AS log
    SET state = 'skipped'
    WHERE log.task_id = p_task_id
      AND log.kind = p_kind
      AND log.due_date = p_due_date
      AND log.state = 'claimed'
      AND log.claim_token = p_claim_token
      AND NOT EXISTS (
        SELECT 1
        FROM discord_bot.tasks AS task
        JOIN discord_bot.events AS event
          ON event.id = task.event_id AND event.guild_id = task.guild_id
        JOIN discord_bot.managed_channels AS channel
          ON channel.guild_id = event.guild_id AND channel.channel_id = event.channel_id
        WHERE task.id = p_task_id
          AND task.status = 'open'
          AND task.deleted_at IS NULL
          AND task.due_date = p_due_date
          AND event.status = 'active'
          AND event.deleted_at IS NULL
          AND event.thread_status <> 'missing'
          AND channel.status = 'active'
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM closed);
$$;

CREATE FUNCTION discord_bot.close_stale_event_reminder(p_event_id uuid, p_kind discord_bot.event_reminder_kind, p_reminder_date date, p_claim_token uuid, p_before_date date) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO ''
    AS $$
  WITH closed AS (
    UPDATE discord_bot.event_reminder_log AS log
    SET state = 'skipped'
    WHERE log.event_id = p_event_id
      AND log.kind = p_kind
      AND log.reminder_date = p_reminder_date
      AND log.state = 'claimed'
      AND log.claim_token = p_claim_token
      AND NOT EXISTS (
        SELECT 1
        FROM discord_bot.events AS event
        JOIN discord_bot.guild_config AS config ON config.guild_id = event.guild_id
        WHERE event.id = p_event_id AND NOT config.reminders_enabled
      )
      AND NOT EXISTS (
        SELECT 1
        FROM discord_bot.events AS event
        WHERE event.id = p_event_id
          AND event.status = 'active'
          AND event.deleted_at IS NULL
          AND event.thread_status <> 'missing'
          AND event.event_date >= p_before_date
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT FROM closed);
$$;

REVOKE ALL ON FUNCTION
  discord_bot.close_stale_reminder(uuid, discord_bot.reminder_kind, date, uuid),
  discord_bot.close_stale_event_reminder(uuid, discord_bot.event_reminder_kind, date, uuid, date)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  discord_bot.close_stale_reminder(uuid, discord_bot.reminder_kind, date, uuid),
  discord_bot.close_stale_event_reminder(uuid, discord_bot.event_reminder_kind, date, uuid, date)
TO bot_app;

-- migrate:down

-- Not reversible: restore from a backup instead. See docs/RECOVERY.md.
