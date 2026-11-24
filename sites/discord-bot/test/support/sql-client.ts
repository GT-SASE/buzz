/**
 * Runners for tests: the migrated database on PGlite, logged in as bot_app, or a
 * recorder that runs nothing. The statements are the ones src/db sends in production:
 * only where they run differs.
 */

import type { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleProxy } from "drizzle-orm/pg-proxy";
import pg from "pg";
import {
  createDbClient,
  type BotDb,
  type DbClient,
  type Row,
  type Runner,
} from "../../src/db/client.ts";
import * as schema from "../../src/db/schema.ts";
import { TYPE_PARSERS } from "../../src/db/parsers.ts";
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

/** PGlite reads each type as Neon's driver is told to in production. */
const PGLITE_PARSERS = Object.fromEntries(TYPE_PARSERS);

/**
 * Runs every statement on the migrated database as bot_app, the role the bot logs in as,
 * so the grants, triggers and functions all apply. `intercept` sees each one first, and
 * may answer it instead. Pass a function for a database made later, such as in a
 * `beforeAll`.
 */
export function pgliteSql(
  source: PGlite | (() => PGlite),
  intercept?: Intercept,
): Runner {
  return async (text, params) => {
    // The intercept runs first and outside the session lock, so it may itself use the
    // database, as a test staging a race does.
    const answer = await intercept?.({ sql: text, params });
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer !== undefined) {
      return answer.rows as Row[];
    }
    const database = typeof source === "function" ? source() : source;
    return onSessionAlone(database, async () => {
      await database.exec(`SET ROLE ${BOT_APP}`);
      try {
        const result = await database.query<Row>(text, [...params], {
          parsers: PGLITE_PARSERS,
        });
        return result.rows;
      } finally {
        await database.exec("RESET ROLE");
      }
    });
  };
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
 * Drizzle over the migrated database on PGlite, logged in as bot_app, as `pgliteSql` is
 * for plain statements. A statement alone, and a whole transaction, each hold the
 * session, so no other caller's statement runs under the role or inside the
 * transaction. `intercept` sees each statement first, as it does for `pgliteSql`. The
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
  return createDbClient(
    pgliteSql(source, intercept),
    pgliteOrm(source, intercept),
  );
}

/**
 * Drizzle that runs nothing and answers every statement with no rows, for a test of code
 * that only has to get as far as writing. It has no transaction.
 */
export function stubOrm(): BotDb {
  return drizzleProxy(() => Promise.resolve({ rows: [] }), {
    schema,
  });
}

/**
 * Drizzle that sends every statement to `run`, one at a time with no transaction around
 * it, for a test of what a single write sends and how a failure of it is reported.
 */
export function recordingOrm(run: Runner): BotDb {
  return drizzleProxy(
    async (text, params) => ({
      rows: await run(text, params, new AbortController().signal),
    }),
    { schema },
  );
}

/** Drizzle over a pg pool, for the concurrency tests. Log the pool in as bot_app. */
export function pgOrm(pool: pg.Pool | pg.Client): BotDb {
  return drizzlePg(pool, { schema });
}

/**
 * Runs every statement through a pg pool, for the concurrency tests on a real Postgres,
 * where each statement needs a connection of its own. Log the pool in as bot_app.
 */
export function pgSql(pool: pg.Pool | pg.Client): Runner {
  const builtin = pg.types.getTypeParser as (
    oid: number,
  ) => (value: string) => unknown;
  const types = {
    getTypeParser: (oid: number) => TYPE_PARSERS.get(oid) ?? builtin(oid),
  };

  return async (text, params) => {
    const result = await pool.query<Row>({
      text,
      values: [...params],
      types,
    });
    return result.rows;
  };
}

/** A runner that runs nothing. It records each statement and answers with `respond`. */
export function recordingSql(respond: Intercept = () => ({ rows: [] })): {
  sql: Runner;
  calls: SqlCall[];
} {
  const calls: SqlCall[] = [];
  const sql: Runner = async (text, params) => {
    const call = { sql: text, params };
    calls.push(call);
    const answer = (await respond(call)) ?? { rows: [] };
    if (answer instanceof Error) {
      throw answer;
    }
    return answer.rows as Row[];
  };
  return { sql, calls };
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
 * A well-formed DATABASE_URL for settings checks. Nothing listens there. The password
 * is set on a parsed URL, so no connection string with a password is tracked.
 */
export function testDatabaseUrl(): string {
  const url = new URL("postgresql://db.example.test/bot?sslmode=verify-full");
  url.username = "bot_app";
  url.password = "not-a-password";
  return url.toString();
}
