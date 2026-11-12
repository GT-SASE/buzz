import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";

export { fakeId } from "../support/ids.ts";

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

const MIGRATIONS_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "db",
  "migrations",
);

/** Each migration's version and its `-- migrate:up` part, in the order dbmate runs them. */
export function migrationsUp(): { version: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const text = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
      const version = /^([0-9]+)_/.exec(name)?.[1];
      const sql =
        /^-- migrate:up[^\n]*\n([\s\S]*?)(?:^-- migrate:down|$(?![\s\S]))/m.exec(
          text,
        )?.[1];
      if (version === undefined || sql === undefined) {
        throw new Error(`${name} is not a dbmate migration`);
      }
      return { version, sql };
    });
}

/**
 * Applies every migration, each in its own transaction, and records it in dbmate's
 * ledger, as `dbmate up` does.
 */
export async function applyMigrations(db: Connection): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS public.schema_migrations (version varchar(128) PRIMARY KEY)",
  );
  for (const { version, sql } of migrationsUp()) {
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query(
        "INSERT INTO public.schema_migrations (version) VALUES ($1)",
        [version],
      );
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** The role the bot logs in as. The baseline migration creates it. */
export const BOT_APP = "bot_app";

/** Runs the migrations and owns the schema, as a Neon project's owner role does. */
export const MIGRATION_OWNER = "migration_owner";

/** A role with no grants at all, standing in for any role that is not the bot or owner. */
export const OTHER_ROLE = "other_role";

/** Postgres error code for a privilege failure. */
export const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * What a new server has before the first migration: an owner that is not a superuser but
 * may create roles, and owns the database and its public schema, as on Neon. Safe to
 * run more than once in a cluster, and in any database.
 */
export const SERVER_SETUP = `
  DO $$
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATION_OWNER}') THEN
      CREATE ROLE ${MIGRATION_OWNER} NOLOGIN NOSUPERUSER CREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${OTHER_ROLE}') THEN
      CREATE ROLE ${OTHER_ROLE} NOLOGIN;
    END IF;
    EXECUTE format('ALTER DATABASE %I OWNER TO ${MIGRATION_OWNER}', current_database());
  END;
  $$;
  ALTER SCHEMA public OWNER TO ${MIGRATION_OWNER};
`;

/** Applies every migration as the owner, as `pnpm db:migrate` does on Neon. */
export async function migrateAsOwner(db: Connection): Promise<void> {
  await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
  try {
    await applyMigrations(db);
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** A fresh database with every migration applied. */
export async function createMigratedDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SERVER_SETUP);
  await migrateAsOwner(db);
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
  role: string,
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

const sessionQueues = new WeakMap<object, Promise<unknown>>();

/**
 * Runs `fn` alone on this connection. PGlite has one session, and a caller that switches
 * its role must not let another caller's statement run under that role.
 */
export function onSessionAlone<T>(
  db: object,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = sessionQueues.get(db) ?? Promise.resolve();
  const next = previous.then(fn);
  sessionQueues.set(
    db,
    next.catch(() => undefined),
  );
  return next;
}
