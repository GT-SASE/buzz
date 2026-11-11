-- A read-only role for the daily backup, which runs from a separate private repo.
-- It has no password and cannot log in until the owner enables it by hand, as
-- docs/BACKUPS.md describes, so no credential passes through a migration.
--
-- Nothing here changes what service_role, anon or authenticated can do.

-- Roles belong to the cluster, so this may already exist in a second database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'backup_ro') THEN
    CREATE ROLE backup_ro NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
      CONNECTION LIMIT 3;
  END IF;
END;
$$;

-- Guards against a mistake, not an attacker: the role can turn this off in its own
-- session. The grants are what stop it changing app data.
ALTER ROLE backup_ro SET default_transaction_read_only = on;

GRANT USAGE ON SCHEMA public, history TO backup_ro;

-- Listed by name, and left out of default privileges, so a new table has no access
-- until a migration grants it. test/db/backup-role.test.ts fails if one is missed.
GRANT SELECT ON TABLE
  public.guild_config,
  public.managed_channels,
  public.events,
  public.tasks,
  public.reminder_log,
  public.job_runs,
  public.config_audit,
  public.interaction_claims,
  history.row_versions
TO backup_ro;

-- pg_dump reads each identity sequence's position. SELECT does not allow nextval.
GRANT SELECT ON SEQUENCE
  public.config_audit_id_seq,
  history.row_versions_id_seq
TO backup_ro;

-- pg_dump stops with an error on a table where row level security would hide rows
-- from it. Only a role that already has BYPASSRLS can hand that attribute on, so try
-- it first. If the platform refuses, give this role alone a SELECT policy per table,
-- which pg_dump honours with --enable-row-security. The backup job always passes that
-- flag, and it changes nothing for a role with BYPASSRLS.
DO $$
BEGIN
  IF NOT (SELECT rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = 'backup_ro') THEN
    BEGIN
      ALTER ROLE backup_ro BYPASSRLS;
    EXCEPTION WHEN insufficient_privilege THEN
      CREATE POLICY backup_ro_read ON public.guild_config FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.managed_channels FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.events FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.tasks FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.reminder_log FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.job_runs FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.config_audit FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON public.interaction_claims FOR SELECT TO backup_ro USING (true);
      CREATE POLICY backup_ro_read ON history.row_versions FOR SELECT TO backup_ro USING (true);
    END;
  END IF;
END;
$$;
