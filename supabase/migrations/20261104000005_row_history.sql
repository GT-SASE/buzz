-- Keeps the previous version of every updated or deleted event and task, out of
-- reach of the bot's role, so a bad write or a leaked key can be recovered from.

CREATE SCHEMA history;
REVOKE ALL ON SCHEMA history FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE history.row_versions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_table text NOT NULL,
  operation    text NOT NULL,
  row_id       text NOT NULL,
  old_row      jsonb NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT row_versions_operation_known CHECK (operation IN ('UPDATE', 'DELETE'))
);

CREATE INDEX row_versions_lookup_idx ON history.row_versions (source_table, row_id, id DESC);

ALTER TABLE history.row_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE history.row_versions FROM PUBLIC, anon, authenticated, service_role;

-- SECURITY DEFINER because the role making the update has no access to this
-- schema. The empty search_path stops a caller from redirecting anything this
-- function resolves, so every name in it is schema-qualified.
CREATE FUNCTION history.record_row_version() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $$
BEGIN
  INSERT INTO history.row_versions (source_table, operation, row_id, old_row)
  VALUES (TG_TABLE_NAME, TG_OP, to_jsonb(OLD) ->> 'id', to_jsonb(OLD));
  RETURN NULL;
END;
$$;

-- TRUNCATE removes rows without firing row triggers, so it would leave no history.
-- The bot's role cannot truncate at all; this stops the owner doing it by accident.
CREATE FUNCTION history.reject_truncate() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'TRUNCATE is not allowed on %', TG_TABLE_NAME USING ERRCODE = 'CF405';
END;
$$;

-- Postgres checks EXECUTE when a trigger is created, not when it fires, so no
-- role needs this grant for the triggers to work.
REVOKE ALL ON FUNCTION history.record_row_version() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION history.reject_truncate() FROM PUBLIC, anon, authenticated, service_role;

-- Separate triggers because a WHEN clause on a DELETE trigger cannot refer to NEW.
-- An update that changes nothing adds no row.
CREATE TRIGGER events_record_update AFTER UPDATE ON public.events
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION history.record_row_version();
CREATE TRIGGER events_record_delete AFTER DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION history.record_row_version();
CREATE TRIGGER tasks_record_update AFTER UPDATE ON public.tasks
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION history.record_row_version();
CREATE TRIGGER tasks_record_delete AFTER DELETE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION history.record_row_version();

CREATE TRIGGER events_reject_truncate BEFORE TRUNCATE ON public.events
  FOR EACH STATEMENT EXECUTE FUNCTION history.reject_truncate();
CREATE TRIGGER tasks_reject_truncate BEFORE TRUNCATE ON public.tasks
  FOR EACH STATEMENT EXECUTE FUNCTION history.reject_truncate();
