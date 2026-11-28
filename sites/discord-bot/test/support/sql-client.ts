/**
 * Clients for tests: the migrated database on PGlite, logged in as bot_app, or a
 * recorder that runs nothing. The statements are the ones src/db sends in production:
 * only where they run differs.
 */

import type { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import type pg from "pg";
import {
  createDbClient,
  type BotDb,
  type DbClient,
} from "../../src/db/client.ts";
import * as schema from "../../src/db/schema.ts";
import { BOT_APP, holdSession, onSessionAlone } from "../db/harness.ts";

/** One statement as src/db sends it. */
export interface SqlCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * What a test answers a statement with instead of running it: rows to return, or an
 * error to throw. Undefined lets the statement run.
 */
export type SqlAnswer = { readonly rows: unknown[] } | Error | undefined;

export type Intercept = (call: SqlCall) => SqlAnswer | Promise<SqlAnswer>;

/** A failure as the server would raise it, with a SQLSTATE and a message to never show. */
export function serverError(code: string, message = "row text"): Error {
  return Object.assign(new Error(message), { code, severity: "ERROR" });
}

/** A request that never reached the server, as Neon's driver reports it. */
export function unavailable(): Error {
  return Object.assign(
    new Error("Error connecting to database: fetch failed"),
    {
      name: "NeonDbError",
    },
  );
}

/**
 * What Drizzle's PGlite driver needs of a client: statements one at a time, and a
 * transaction that hands its statements to a callback.
 */
interface PgliteClientLike {
  query: (
    text: string,
    params: unknown[],
    options?: Record<string, unknown>,
  ) => Promise<unknown>;
  transaction: <T>(work: (tx: PgliteClientLike) => Promise<T>) => Promise<T>;
}

/**
 * Drizzle over the migrated database on PGlite, logged in as bot_app. A statement alone, and a whole transaction, each hold the
 * session, so no other caller's statement runs under the role or inside the
 * transaction. `intercept` sees each statement first, and may answer it instead. The
 * first statement of a transaction is seen before the transaction begins, so a test that
 * stages a race at it can use the database without waiting on the transaction it is
 * about to start. Later ones are seen inside it, and may answer with an error.
 */
export function pgliteOrm(
  source: PGlite | (() => PGlite),
  intercept?: Intercept,
): BotDb {
  const database = (): PGlite =>
    typeof source === "function" ? source() : source;

  /** What the intercept answers a statement with, instead of running it. */
  const seen = async (
    text: string,
    params: unknown[],
  ): Promise<{ rows: unknown[]; fields: [] } | undefined> => {
    const answer = await intercept?.({ sql: text, params });
    if (answer instanceof Error) {
      throw answer;
    }
    return answer === undefined ? undefined : { rows: answer.rows, fields: [] };
  };

  const client: PgliteClientLike = {
    query: async (text, params, options) => {
      const answered = await seen(text, params);
      if (answered !== undefined) {
        return answered;
      }
      const db = database();
      return onSessionAlone(db, async () => {
        await db.exec(`SET ROLE ${BOT_APP}`);
        try {
          return await db.query(text, params, options);
        } finally {
          await db.exec("RESET ROLE");
        }
      });
    },
    transaction: async (work) => {
      const db = database();
      // The session is taken at the first statement that runs, after the intercept has
      // seen it, and kept to the end, so nothing else runs between the statements of one
      // transaction.
      let release: (() => void) | undefined;
      const inside: PgliteClientLike = {
        query: async (text, params, options) => {
          const answered = await seen(text, params);
          if (answered !== undefined) {
            return answered;
          }
          if (release === undefined) {
            release = await holdSession(db);
            await db.exec(`SET ROLE ${BOT_APP}`);
            await db.exec("BEGIN");
          }
          return db.query(text, params, options);
        },
        transaction: () => {
          throw new Error("no nested transactions in tests");
        },
      };
      try {
        const result = await work(inside);
        if (release !== undefined) await db.exec("COMMIT");
        return result;
      } catch (error) {
        if (release !== undefined) await db.exec("ROLLBACK");
        throw error;
      } finally {
        if (release !== undefined) {
          await db.exec("RESET ROLE");
          release();
        }
      }
    },
  };
  return drizzlePglite({
    client: client as unknown as PGlite,
    schema,
  });
}

/** A client for the migrated PGlite database: reads and single statements, and transactions. */
export function pgliteClient(
  source: PGlite | (() => PGlite),
  intercept?: Intercept,
): DbClient {
  return createDbClient(pgliteOrm(source, intercept));
}

/**
 * Drizzle that sends every statement to `respond` and runs nothing, for a test of what the
 * bot sends and how a failure of it is reported. It has no transaction. A row `respond`
 * answers with is given as an object, and goes back as the array Drizzle reads by
 * position, in the order of its keys.
 */
export function recordingOrm(respond: Intercept = () => ({ rows: [] })): {
  orm: BotDb;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const orm = drizzleProxy(
    async (text, params, method) => {
      const call = { sql: text, params };
      calls.push(call);
      const answer = (await respond(call)) ?? { rows: [] };
      if (answer instanceof Error) {
        throw answer;
      }
      return {
        rows:
          method === "all"
            ? answer.rows.map((row) =>
                Array.isArray(row)
                  ? (row as unknown[])
                  : Object.values(row as Record<string, unknown>),
              )
            : answer.rows,
      };
    },
    { schema },
  );
  // The statements are only recorded, so a transaction is just its statements.
  Object.assign(orm, {
    transaction: <T>(work: (tx: unknown) => Promise<T>) => work(orm),
  });
  return { orm: orm, calls };
}

/** A client that runs nothing and answers with no rows. */
export function stubOrm(): BotDb {
  return recordingOrm().orm;
}

/** Drizzle over a pg pool or client, for the concurrency tests. Log in as bot_app. */
export function pgOrm(pool: pg.Pool | pg.Client): BotDb {
  return drizzlePg(pool, { schema });
}

/** A client that runs nothing. It records each statement and answers with `respond`. */
export function recordingClient(respond?: Intercept): {
  db: DbClient;
  calls: SqlCall[];
} {
  const { orm, calls } = recordingOrm(respond);
  return { db: createDbClient(orm), calls };
}

/**
 * Whether a statement names this table, for a test to fail or answer it, or matches this
 * pattern, for one statement among several on the same table.
 */
export function names(call: SqlCall, name: string | RegExp): boolean {
  const pattern = typeof name === "string" ? new RegExp(`\\b${name}\\b`) : name;
  return pattern.test(call.sql);
}

/**
 * A well-formed DISCORD_BOT_DATABASE_URL for settings checks. Nothing listens there. The password
 * is set on a parsed URL, so no connection string with a password is tracked.
 */
export function testDatabaseUrl(): string {
  const url = new URL("postgresql://db.example.test/bot?sslmode=verify-full");
  url.username = "bot_app";
  url.password = "not-a-password";
  return url.toString();
}
