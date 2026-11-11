-- Core tables, with row level security and grants applied in the same migration
-- so no table ever exists in an open state.

-- Discord IDs are 64-bit unsigned integers that JavaScript cannot hold exactly,
-- so they are stored as text and checked for shape here.
CREATE DOMAIN public.discord_id AS text
  CHECK (VALUE ~ '^[0-9]{17,20}$');

CREATE TYPE public.managed_channel_status AS ENUM ('active', 'unavailable', 'removed');
CREATE TYPE public.event_status AS ENUM ('active', 'closed');
CREATE TYPE public.thread_status AS ENUM ('pending', 'active', 'missing');
CREATE TYPE public.task_status AS ENUM ('open', 'done');
CREATE TYPE public.reminder_kind AS ENUM ('three_days', 'one_day', 'due_day', 'overdue');
CREATE TYPE public.reminder_state AS ENUM ('claimed', 'sent', 'skipped');
CREATE TYPE public.job_run_status AS ENUM ('running', 'succeeded', 'failed');

CREATE TABLE public.guild_config (
  guild_id          public.discord_id PRIMARY KEY,
  officer_role_id   public.discord_id NOT NULL,
  admin_role_id     public.discord_id NOT NULL,
  timezone          text NOT NULL DEFAULT 'America/New_York',
  reminders_enabled boolean NOT NULL DEFAULT true,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- The @everyone role's ID equals the guild ID. Binding it would give every
  -- member officer or admin access.
  CONSTRAINT guild_config_officer_not_everyone CHECK (officer_role_id <> guild_id),
  CONSTRAINT guild_config_admin_not_everyone CHECK (admin_role_id <> guild_id),
  CONSTRAINT guild_config_version_positive CHECK (version >= 1)
);

CREATE TABLE public.managed_channels (
  guild_id   public.discord_id NOT NULL REFERENCES public.guild_config (guild_id),
  channel_id public.discord_id NOT NULL,
  status     public.managed_channel_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE public.events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id            public.discord_id NOT NULL,
  channel_id          public.discord_id NOT NULL,
  name                text NOT NULL,
  event_date          date NOT NULL,
  thread_id           public.discord_id,
  overview_message_id public.discord_id,
  status              public.event_status NOT NULL DEFAULT 'active',
  thread_status       public.thread_status NOT NULL DEFAULT 'pending',
  created_by          public.discord_id NOT NULL,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- The composite keys stop an event pointing at another guild's channel and a
  -- task pointing at another guild's event.
  FOREIGN KEY (guild_id, channel_id) REFERENCES public.managed_channels (guild_id, channel_id),
  CONSTRAINT events_id_guild_unique UNIQUE (id, guild_id),
  -- 100 characters is Discord's limit for a forum post title.
  CONSTRAINT events_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  CONSTRAINT events_event_date_range CHECK (event_date BETWEEN '2000-01-01' AND '9999-12-31'),
  CONSTRAINT events_thread_matches_status CHECK ((thread_id IS NULL) = (thread_status = 'pending'))
);

CREATE TABLE public.tasks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL,
  guild_id     public.discord_id NOT NULL,
  assignee_id  public.discord_id NOT NULL,
  description  text NOT NULL,
  due_date     date NOT NULL,
  status       public.task_status NOT NULL DEFAULT 'open',
  completed_at timestamptz,
  created_by   public.discord_id NOT NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, guild_id) REFERENCES public.events (id, guild_id),
  CONSTRAINT tasks_description_length CHECK (char_length(description) BETWEEN 1 AND 1000),
  -- Date arithmetic in the reminder planner cannot handle infinity or BC dates, and
  -- the same range applies to every date column here.
  CONSTRAINT tasks_due_date_range CHECK (due_date BETWEEN '2000-01-01' AND '9999-12-31'),
  CONSTRAINT tasks_completed_matches_status CHECK ((completed_at IS NOT NULL) = (status = 'done'))
);

-- The primary key is what makes reminder sends claimable: a second claim for the
-- same task, kind and due date conflicts instead of producing a second message.
-- The due date is part of the key so that moving a task's date re-arms its
-- reminders. The token identifies the current claimant, so a worker whose claim
-- has been taken over cannot mark it sent.
CREATE TABLE public.reminder_log (
  task_id     uuid NOT NULL REFERENCES public.tasks (id),
  kind        public.reminder_kind NOT NULL,
  due_date    date NOT NULL,
  state       public.reminder_state NOT NULL DEFAULT 'claimed',
  claim_token uuid NOT NULL DEFAULT gen_random_uuid(),
  attempts    integer NOT NULL DEFAULT 1,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz,
  message_id  public.discord_id,
  PRIMARY KEY (task_id, kind, due_date),
  CONSTRAINT reminder_log_due_date_range CHECK (due_date BETWEEN '2000-01-01' AND '9999-12-31'),
  CONSTRAINT reminder_log_attempts_positive CHECK (attempts >= 1),
  CONSTRAINT reminder_log_sent_at_matches_state CHECK ((sent_at IS NOT NULL) = (state = 'sent')),
  CONSTRAINT reminder_log_message_only_when_sent CHECK (message_id IS NULL OR state = 'sent')
);

CREATE TABLE public.job_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     text NOT NULL,
  status       public.job_run_status NOT NULL DEFAULT 'running',
  started_at   timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  results      jsonb NOT NULL DEFAULT '{}',
  error        text,
  CONSTRAINT job_runs_job_name_length CHECK (char_length(job_name) BETWEEN 1 AND 64),
  -- char_length counts code points in a UTF-8 database, so these limits do not
  -- depend on how many bytes a character takes. The text and jsonb types already
  -- refuse NUL characters, so no column here needs a check for them.
  CONSTRAINT job_runs_results_size CHECK (char_length(results::text) <= 16000),
  CONSTRAINT job_runs_error_size CHECK (char_length(error) <= 4000),
  CONSTRAINT job_runs_finished_matches_status CHECK ((finished_at IS NULL) = (status = 'running'))
);

-- Append-only for the API role, which can only read it.
CREATE TABLE public.config_audit (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id      public.discord_id NOT NULL REFERENCES public.guild_config (guild_id),
  actor_id      public.discord_id NOT NULL,
  action        text NOT NULL,
  old_values    jsonb,
  new_values    jsonb NOT NULL,
  version_after integer NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT config_audit_action_known CHECK (action IN ('role_bindings', 'settings'))
);

-- A thread can belong to one live event. A soft-deleted event gives its thread up,
-- so a new event can adopt it.
CREATE UNIQUE INDEX events_live_thread_uq ON public.events (thread_id)
  WHERE deleted_at IS NULL AND thread_id IS NOT NULL;
-- Reminder run: open tasks due up to a date, across all guilds.
CREATE INDEX tasks_open_by_due_date_idx ON public.tasks (due_date, guild_id)
  WHERE status = 'open' AND deleted_at IS NULL;
-- /mytasks: one person's open tasks in one guild, soonest first.
CREATE INDEX tasks_open_by_assignee_idx ON public.tasks (guild_id, assignee_id, due_date)
  WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX tasks_event_idx ON public.tasks (event_id);
CREATE INDEX events_channel_idx ON public.events (guild_id, channel_id);
CREATE INDEX events_live_by_date_idx ON public.events (guild_id, event_date)
  WHERE deleted_at IS NULL;
-- Finding claims left behind by a crashed reminder run.
CREATE INDEX reminder_log_open_claims_idx ON public.reminder_log (claimed_at)
  WHERE state = 'claimed';
CREATE INDEX job_runs_latest_idx ON public.job_runs (job_name, started_at DESC);
CREATE INDEX config_audit_guild_idx ON public.config_audit (guild_id, id DESC);

-- Leaves updated_at alone on an update that changes nothing, so that the row stays
-- identical and the history trigger can tell it was a no-op.
CREATE FUNCTION public.set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guild_config_set_updated_at BEFORE UPDATE ON public.guild_config
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER managed_channels_set_updated_at BEFORE UPDATE ON public.managed_channels
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER events_set_updated_at BEFORE UPDATE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- pg_timezone_names cannot be read from a CHECK constraint, so a trigger validates
-- the name. It skips unchanged values because that view is slow to read.
CREATE FUNCTION public.check_guild_timezone() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.timezone = OLD.timezone THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown timezone' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER guild_config_check_timezone BEFORE INSERT OR UPDATE OF timezone ON public.guild_config
  FOR EACH ROW EXECUTE FUNCTION public.check_guild_timezone();

-- Refuses new work under a removed channel or a closed or deleted event, raising
-- SQLSTATE CF410. A foreign key takes only FOR KEY SHARE, which does not conflict
-- with an ordinary update, so this takes FOR SHARE to make a concurrent removal or
-- soft delete wait for this insert, or this insert wait for it.
--
-- SECURITY DEFINER because FOR SHARE needs UPDATE on the parent, and the bot's role
-- has no UPDATE on managed_channels. A missing parent is left for the foreign key
-- to report.
CREATE FUNCTION public.require_open_parent() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
DECLARE
  v_channel_status public.managed_channel_status;
  v_event_status public.event_status;
  v_event_deleted_at timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'events' THEN
    SELECT status INTO v_channel_status
    FROM public.managed_channels
    WHERE guild_id = NEW.guild_id AND channel_id = NEW.channel_id
    FOR SHARE;

    IF v_channel_status = 'removed' THEN
      RAISE EXCEPTION 'channel has been removed' USING ERRCODE = 'CF410';
    END IF;
  ELSE
    SELECT status, deleted_at INTO v_event_status, v_event_deleted_at
    FROM public.events
    WHERE id = NEW.event_id AND guild_id = NEW.guild_id
    FOR SHARE;

    IF v_event_status = 'closed' OR v_event_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'event is closed or deleted' USING ERRCODE = 'CF410';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER events_require_open_parent BEFORE INSERT ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();
CREATE TRIGGER tasks_require_open_parent BEFORE INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.require_open_parent();

-- No policies are defined. Only the owning role and roles with BYPASSRLS can see
-- rows, which on Supabase means the migration role and service_role.
ALTER TABLE public.guild_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.managed_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.config_audit ENABLE ROW LEVEL SECURITY;

-- Default privileges already leave these objects closed. The explicit REVOKE keeps
-- that true if a default ever changes on the platform's side.
REVOKE ALL ON TABLE
  public.guild_config,
  public.managed_channels,
  public.events,
  public.tasks,
  public.reminder_log,
  public.job_runs,
  public.config_audit
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
  public.set_updated_at(),
  public.check_guild_timezone(),
  public.require_open_parent()
FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON DOMAIN public.discord_id FROM PUBLIC;
REVOKE ALL ON TYPE
  public.managed_channel_status,
  public.event_status,
  public.thread_status,
  public.task_status,
  public.reminder_kind,
  public.reminder_state,
  public.job_run_status
FROM PUBLIC;

GRANT USAGE ON DOMAIN public.discord_id TO service_role;
GRANT USAGE ON TYPE
  public.managed_channel_status,
  public.event_status,
  public.thread_status,
  public.task_status,
  public.reminder_kind,
  public.reminder_state,
  public.job_run_status
TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.job_runs TO service_role;

-- Events and tasks can be updated only in the columns listed. Left out on purpose:
-- ownership (guild, parent event, channel), which must not change after the insert
-- checks have run, events.deleted_at, which must also delete the event's tasks, and
-- the timestamps and authorship.
GRANT SELECT, INSERT ON TABLE public.events, public.tasks TO service_role;
GRANT UPDATE (name, event_date, thread_id, overview_message_id, status, thread_status)
  ON TABLE public.events TO service_role;
GRANT UPDATE (assignee_id, description, due_date, status, completed_at, deleted_at)
  ON TABLE public.tasks TO service_role;

-- Read-only for the bot's role, so a direct write cannot skip the version checks,
-- audit rows and claim tokens that these tables depend on.
GRANT SELECT ON TABLE
  public.guild_config,
  public.managed_channels,
  public.reminder_log,
  public.config_audit
TO service_role;
