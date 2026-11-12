/**
 * Runners for tests: the migrated database on PGlite, logged in as bot_app, or a
 * recorder that runs nothing. The statements are the ones src/db sends in production:
 * only where they run differs.
 */

import type { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Row, Runner } from "../../src/db/client.ts";
import { TYPE_PARSERS } from "../../src/db/parsers.ts";
import { BOT_APP, onSessionAlone } from "../db/harness.ts";

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
export const PGLITE_PARSERS = Object.fromEntries(TYPE_PARSERS);

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
 * Runs every statement through a pg pool, for the concurrency tests on a real Postgres,
 * where each statement needs a connection of its own. Log the pool in as bot_app.
 */
export function pgSql(pool: pg.Pool): Runner {
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

/** Whether a statement names this table or function, for a test to fail or answer it. */
export function names(call: SqlCall, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(call.sql);
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
