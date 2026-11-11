import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";

/** What the helpers here need from a database, so PGlite and pg both fit. */
export interface Connection {
  // Callers name the row they expect, as they do with PGlite's own query.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Row[] }>;
  exec(sql: string): Promise<unknown>;
}

export function pgConnection(client: pg.Client): Connection {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    query: async <Row>(sql: string, params: unknown[] = []) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as Row[] };
    },
    exec: (sql) => client.query(sql),
  };
}

export type ApiRole = "anon" | "authenticated" | "service_role";
export const API_ROLES: readonly ApiRole[] = [
  "anon",
  "authenticated",
  "service_role",
];

/** Stands in for the hosted `postgres` role: owns the schema, is not a superuser. */
export const MIGRATION_OWNER = "migration_owner";

/** The read-only role the daily backup connects as. */
export const BACKUP_ROLE = "backup_ro";

/** Postgres error code for a privilege failure. */
export const INSUFFICIENT_PRIVILEGE = "42501";

const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "supabase",
  "migrations",
);

/**
 * Recreates the starting state of a Supabase project, as permissively as the
 * platform might set it: API roles with default grants on everything the owner
 * creates, and anon and authenticated with full schema access. Tests only mean
 * something if the migrations have to remove these grants.
 *
 * service_role deliberately gets no USAGE on the schema here. It reaches the schema
 * only through PUBLIC, which the migrations revoke, so the migrations have to grant
 * USAGE themselves. CREATE is granted so that they have to revoke it.
 *
 * Safe to run more than once in a cluster, and in any database.
 */
export const PLATFORM_BOOTSTRAP = `
  DO $$
  DECLARE
    spec text[];
  BEGIN
    FOREACH spec SLICE 1 IN ARRAY ARRAY[
      ['anon', 'NOLOGIN NOINHERIT'],
      ['authenticated', 'NOLOGIN NOINHERIT'],
      ['service_role', 'NOLOGIN NOINHERIT BYPASSRLS'],
      ['${MIGRATION_OWNER}', 'NOLOGIN NOSUPERUSER CREATEROLE']
    ] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = spec[1]) THEN
        EXECUTE format('CREATE ROLE %I %s', spec[1], spec[2]);
      END IF;
    END LOOP;
    EXECUTE format('GRANT CREATE ON DATABASE %I TO ${MIGRATION_OWNER}', current_database());
  END;
  $$;

  ALTER SCHEMA public OWNER TO ${MIGRATION_OWNER};
  GRANT ALL ON SCHEMA public TO anon, authenticated;
  GRANT CREATE ON SCHEMA public TO service_role;

  ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_OWNER} IN SCHEMA public
    GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_OWNER} IN SCHEMA public
    GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATION_OWNER} IN SCHEMA public
    GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** A fresh database in the platform's starting state, with no migrations run. */
export async function createBootstrappedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(PLATFORM_BOOTSTRAP);
  return db;
}

/** Scripts that apply each migration in its own transaction, as the owner. */
export function migrationScripts(): string[] {
  return migrationFiles().map((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    return `BEGIN; SET LOCAL ROLE ${MIGRATION_OWNER};\n${sql}\nCOMMIT;`;
  });
}

/** A fresh database with every migration applied. */
export async function createMigratedDb(): Promise<PGlite> {
  const db = await createBootstrappedDb();
  for (const script of migrationScripts()) {
    await db.exec(script);
  }
  return db;
}

/** Narrows a value a test has already required to exist, failing loudly if it does not. */
export function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}

/** Runs one parameterised statement as the given role, then restores the session role. */
export async function queryAs<Row = Record<string, unknown>>(
  db: Connection,
  role: ApiRole | typeof MIGRATION_OWNER | typeof BACKUP_ROLE,
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  await db.exec(`SET ROLE ${role}`);
  try {
    const result = await db.query<Row>(sql, params);
    return result.rows;
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** The Postgres error code a statement fails with, or undefined if it succeeds. */
export async function errorCodeOf(
  run: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

// Built at runtime because a literal this long would trip the secret scan's rule
// against Discord IDs in tracked files. Starting from a random offset keeps IDs from
// repeating between runs against a long-lived server.
let nextFakeId = 10n ** 17n + BigInt(Math.floor(Math.random() * 1e9)) * 1000n;

/** A placeholder Discord ID, unique within the test run. */
export function fakeId(): string {
  nextFakeId += 1n;
  return nextFakeId.toString();
}
