/**
 * The database client: something that runs one statement, and how long a statement may
 * take. Production builds it on first use, so importing this file reads no setting.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDatabaseUrl } from "../lib/env.ts";
import { neonOrm, neonRunner } from "./neon.ts";
import type * as schema from "./schema.ts";

/** A row as the driver returns it, with the column types read as `TYPE_PARSERS` says. */
export type Row = Record<string, unknown>;

/** Sends one statement with `$n` parameters and returns its rows. */
export type Runner = (
  text: string,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<Row[]>;

/**
 * Drizzle over a connection that can hold a transaction: `orm.transaction(...)` for a
 * write that takes locks or checks a version, and the builder for a single statement.
 * Neon's HTTP driver sends one statement per request, so it cannot hold either: reads go
 * through `run`, writes through `orm`.
 */
export type BotDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** What a transaction callback is given. It builds statements as `BotDb` does. */
export type BotTx = Parameters<Parameters<BotDb["transaction"]>[0]>[0];

export interface DbClient {
  readonly run: Runner;
  readonly orm: BotDb;
  readonly deadlineMs: number;
}

const DEFAULT_DEADLINE_MS = 8000;

/**
 * For a request Discord is waiting on. Discord allows 3 seconds for the first reply.
 * The read has to fit a cold function and a Neon compute waking from suspend, and
 * still leave time for a fixed reply if it fails. An interaction handler makes one
 * such read and defers anything more.
 */
const INTERACTION_DEADLINE_MS = 2200;

/** What a client built with no write connection does when a write reaches for one. */
// eslint-disable-next-line @typescript-eslint/no-unsafe-class-instance-assignment -- a stand-in that fails when used
const NO_WRITE_CONNECTION = new Proxy(
  {},
  {
    get(): never {
      throw new Error("this client has no connection for writes");
    },
  },
) as BotDb;

/**
 * A client on Neon in production, or PGlite or pg in tests. A client for tests that
 * only read, or that stub `run`, needs no `orm`.
 */
export function createDbClient(
  run: Runner,
  orm: BotDb = NO_WRITE_CONNECTION,
): DbClient {
  return { run, orm, deadlineMs: DEFAULT_DEADLINE_MS };
}

/**
 * The same client with a shorter limit on each statement. One over the limit is
 * abandoned and fails as `unavailable`.
 */
export function withDeadline(db: DbClient, deadlineMs: number): DbClient {
  return { run: db.run, orm: db.orm, deadlineMs };
}

let client: DbClient | undefined;

/** One client for the life of the function instance, for handlers and the cron. */
export function getDb(): DbClient {
  const url = getDatabaseUrl();
  client ??= createDbClient(neonRunner(url), neonOrm(url));
  return client;
}

/** The client for a handler that has not deferred. See `INTERACTION_DEADLINE_MS`. */
export function getInteractionDb(): DbClient {
  return withDeadline(getDb(), INTERACTION_DEADLINE_MS);
}
