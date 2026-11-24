import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
function migrationsUp(): { version: string; sql: string }[] {
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
async function applyMigrations(db: Connection): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS discord_bot.schema_migrations (version varchar(128) PRIMARY KEY)",
  );
  for (const { version, sql } of migrationsUp()) {
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query(
        "INSERT INTO discord_bot.schema_migrations (version) VALUES ($1)",
        [version],
      );
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw error;
    }
  }
}

/**
 * For beforeAll and similar hooks that build a database. Tests get 30 seconds from
 * the test:db scripts; a hook that migrates or copies a database may need longer.
 */
export const HOOK_TIMEOUT_MS = 120_000;

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
 * may create roles, and owns the database and its public schema, as on Neon, plus the
 * empty discord_bot schema docs/SETUP.md has the owner make before the first migration
 * (dbmate keeps its ledger there). Safe to run more than once in a cluster.
 */
const SERVER_SETUP = `
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
  CREATE SCHEMA IF NOT EXISTS discord_bot AUTHORIZATION ${MIGRATION_OWNER};
`;

/** Applies every migration as the owner, as `bun run db:migrate` does on Neon. */
async function migrateAsOwner(db: Connection): Promise<void> {
  await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
  try {
    await applyMigrations(db);
  } finally {
    await db.exec("RESET ROLE");
  }
}

/** A fresh server with every migration applied, built from nothing. */
async function buildMigratedDb(
  beforeMigrations?: (db: PGlite) => Promise<void>,
): Promise<PGlite> {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(SERVER_SETUP);
  if (beforeMigrations !== undefined) {
    await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
    try {
      await beforeMigrations(db);
    } finally {
      await db.exec("RESET ROLE");
    }
  }
  await migrateAsOwner(db);
  return db;
}

const DUMP_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "node_modules",
  ".cache",
  "pglite-migrated",
);

/**
 * The tar every test file starts from, named after what goes into it: this file, each
 * migration and the PGlite version. Change any of them and a new tar is built.
 */
function dumpPath(): string {
  const pglite = join(
    dirname(fileURLToPath(import.meta.resolve("@electric-sql/pglite"))),
    "..",
    "package.json",
  );
  const hash = createHash("sha256")
    .update(readFileSync(import.meta.filename))
    .update(readFileSync(pglite));
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    hash.update(name).update(readFileSync(join(MIGRATIONS_DIR, name)));
  }
  return join(DUMP_DIR, `${hash.digest("hex").slice(0, 20)}.tar`);
}

let dump: Promise<Blob> | undefined;

/**
 * The data directory of a fresh server with every migration applied, as a tar that
 * `new PGlite({ loadDataDir })` restores in a fraction of the time it takes to boot
 * PGlite and run the migrations. The first caller on a machine builds it and keeps it
 * on disk, so the other test files, which run in their own processes, load it instead
 * of building it again.
 */
export function migratedDump(): Promise<Blob> {
  dump ??= (async () => {
    const path = dumpPath();
    const kept = Bun.file(path);
    if (await kept.exists()) return new Blob([await kept.arrayBuffer()]);
    const db = await buildMigratedDb();
    const built = await db.dumpDataDir("none");
    await db.close();
    // Written beside the target and renamed into place, so a file that is read is
    // always whole. Two files that build at once both write the same bytes, so a
    // rename that loses to the other is harmless.
    const temporary = `${path}.${String(process.pid)}.tmp`;
    try {
      mkdirSync(DUMP_DIR, { recursive: true });
      for (const old of readdirSync(DUMP_DIR)) {
        if (old.endsWith(".tar") && join(DUMP_DIR, old) !== path) {
          rmSync(join(DUMP_DIR, old), { force: true });
        }
      }
      await Bun.write(temporary, built);
      renameSync(temporary, path);
    } catch {
      rmSync(temporary, { force: true });
    }
    return built;
  })();
  return dump;
}

/**
 * A fresh database with every migration applied. `beforeMigrations` runs as the owner
 * first, to put something else in the database, as buzz's own tables are on Neon; a
 * database that needs it is built from nothing, any other is restored from the shared tar.
 */
export async function createMigratedDb(
  beforeMigrations?: (db: PGlite) => Promise<void>,
): Promise<PGlite> {
  if (beforeMigrations !== undefined) return buildMigratedDb(beforeMigrations);
  const db = new PGlite({ loadDataDir: await migratedDump() });
  await db.waitReady;
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
  return onSessionAlone(db, async () => {
    await db.exec(`SET ROLE ${role}`);
    try {
      const result = await db.query<Row>(sql, params);
      return result.rows;
    } finally {
      await db.exec("RESET ROLE");
    }
  });
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
