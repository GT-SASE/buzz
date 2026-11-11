-- Lets the backup role read which migrations this database has applied, so each backup's
-- manifest can record them. A recovery from that backup then marks only those as applied and
-- runs the rest. Otherwise an older backup would have later migrations marked as applied
-- without ever running, as docs/BACKUPS.md explains.
--
-- Only the version column: the table's other columns hold the migrations' text and add
-- nothing to a backup.
--
-- The Supabase CLI creates this table, so a server that was not migrated by the CLI has none.
-- A role that does not own it cannot grant on it. Neither stops the migration, because the
-- backup job refuses to run without this access and says why, and
-- backup/grant-backup-role.psql can give it afterwards.
DO $$
BEGIN
  IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA supabase_migrations TO backup_ro;
    GRANT SELECT (version) ON TABLE supabase_migrations.schema_migrations TO backup_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'could not give backup_ro read access to the applied migrations';
END;
$$;
