-- Limits on creating and reassigning tasks, so one officer account, stolen or careless,
-- cannot fill an event's lists or flood members with pings. Triggers enforce them because
-- a count in the handler could be passed by two writes at once.
--
-- Per event: 100 live tasks, done ones included, which is also the most that a read of
-- an event's tasks returns. Per officer per guild: 50 pings' worth of new tasks and
-- reassignments together in any 24 hours, with deleted tasks still counted, so deleting
-- does not refill the allowance.
--
-- src/db/tasks.ts repeats both numbers for the refusal text, and a test holds them equal.

-- The per-officer count below. The per-event count uses tasks_event_idx.
CREATE INDEX tasks_by_creator_idx ON public.tasks (guild_id, created_by, created_at);

-- One row per reassignment, written before the task changes. An edit that then fails
-- leaves its row behind and costs that officer one of the 50. The rows are few, and they
-- are kept like history.
CREATE TABLE public.task_reassignments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id   public.discord_id NOT NULL REFERENCES public.guild_config (guild_id),
  actor_id   public.discord_id NOT NULL,
  task_id    uuid NOT NULL REFERENCES public.tasks (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_reassignments_by_actor_idx
  ON public.task_reassignments (guild_id, actor_id, created_at);

ALTER TABLE public.task_reassignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.task_reassignments FROM PUBLIC, anon, authenticated, service_role;
-- created_at is left out, so a row cannot be backdated to dodge the count.
GRANT INSERT (guild_id, actor_id, task_id) ON TABLE public.task_reassignments TO service_role;

-- The same read-only access as every other table, by the same two routes the backup role's
-- migration explains.
GRANT SELECT ON TABLE public.task_reassignments TO backup_ro;
GRANT SELECT ON SEQUENCE public.task_reassignments_id_seq TO backup_ro;
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'backup_ro') THEN
    CREATE POLICY backup_ro_read ON public.task_reassignments FOR SELECT TO backup_ro USING (true);
  END IF;
END;
$$;

-- SECURITY DEFINER so the counts always see every row, whatever the row level security
-- settings of the role inserting. The locks last until the transaction ends and make two
-- writes for one event or one officer take turns, and Read Committed then lets the later
-- one count what the earlier one committed. Under a higher isolation level it would count
-- from an older snapshot and could pass the limit, so that is refused.
--
-- An insert takes the event's lock and then the officer's, so two single-row writes cannot
-- wait on each other. A transaction holding several writes across events or officers can
-- still deadlock with another. Postgres then cancels one, which fails safely, and the bot
-- sends one write per request.
CREATE FUNCTION public.enforce_task_quotas() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'task quotas need read committed' USING ERRCODE = '0A000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-event:' || NEW.event_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-actor:' || NEW.guild_id || ':' || NEW.created_by, 0)
  );

  IF (
    SELECT count(*) FROM public.tasks
    WHERE event_id = NEW.event_id AND deleted_at IS NULL
  ) >= 100 THEN
    RAISE EXCEPTION 'event task limit reached' USING ERRCODE = 'CF429';
  END IF;

  IF (
    SELECT count(*) FROM public.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM public.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.created_by
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;

CREATE FUNCTION public.enforce_reassignment_quota() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'task quotas need read committed' USING ERRCODE = '0A000';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('task-quota-actor:' || NEW.guild_id || ':' || NEW.actor_id, 0)
  );

  IF (
    SELECT count(*) FROM public.tasks
    WHERE guild_id = NEW.guild_id
      AND created_by = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) + (
    SELECT count(*) FROM public.task_reassignments
    WHERE guild_id = NEW.guild_id
      AND actor_id = NEW.actor_id
      AND created_at > now() - interval '24 hours'
  ) >= 50 THEN
    RAISE EXCEPTION 'officer task limit reached' USING ERRCODE = 'CF430';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION
  public.enforce_task_quotas(),
  public.enforce_reassignment_quota()
FROM PUBLIC, anon, authenticated, service_role;

-- Named to fire after tasks_require_open_parent, as triggers run in name order, so a
-- closed event is reported as closed and not as full.
CREATE TRIGGER tasks_require_quota BEFORE INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.enforce_task_quotas();
CREATE TRIGGER task_reassignments_require_quota BEFORE INSERT ON public.task_reassignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_reassignment_quota();
