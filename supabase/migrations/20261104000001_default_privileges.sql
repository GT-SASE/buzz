-- Close access before any object exists, so a table, function or type added by a
-- later migration starts with no grants until that migration adds them.
--
-- ALTER DEFAULT PRIVILEGES applies only to objects created by the role running
-- this migration. Hosted Supabase ships default grants to anon, authenticated
-- and service_role on the public schema, and those are what this removes.

-- Only the bot's role reaches this schema at all. The anon and authenticated
-- roles are denied at the schema, as well as on each table.
REVOKE ALL ON SCHEMA public FROM PUBLIC, anon, authenticated;
REVOKE CREATE ON SCHEMA public FROM service_role;
GRANT USAGE ON SCHEMA public TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TYPES FROM PUBLIC, anon, authenticated, service_role;

-- EXECUTE and type USAGE for PUBLIC are built-in defaults, not per-schema ones. A
-- schema-scoped statement cannot remove them, so these have no IN SCHEMA clause
-- and cover every schema.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM PUBLIC;
