/**
 * The database client: Drizzle for reads and single statements, a way to open a
 * connection for a transaction, and how long a statement may take. Production builds it on
 * first use, so importing this file reads no setting.
 */

import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { getDatabaseUrl } from "../lib/env.ts";
import { neonHttp, neonOpen } from "./neon.ts";
import type * as schema from "./schema.ts";

/**
 * Drizzle on a connection. In production, reads and single statements go over Neon's
 * HTTP driver, one request each with nothing to open or lose between requests; a
 * transaction needs one connection for all its statements, so `open` gives it one.
 */
export type BotDb = PgDatabase<PgQueryResultHKT, typeof schema>;

/** What a transaction callback is given. It builds statements as `BotDb` does. */
export type BotTx = Parameters<Parameters<BotDb["transaction"]>[0]>[0];

export interface DbClient {
  readonly orm: BotDb;
  /** Runs a write on a connection opened for it and closed after. Without it, `orm`. */
  readonly open?: <T>(
    work: (orm: BotDb) => Promise<T>,
    limits: { signal: AbortSignal; deadlineMs: number },
  ) => Promise<T>;
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

/** A client on Neon in production, or PGlite or pg in tests. */
export function createDbClient(orm: BotDb, open?: DbClient["open"]): DbClient {
  return open === undefined
    ? { orm, deadlineMs: DEFAULT_DEADLINE_MS }
    : { orm, open, deadlineMs: DEFAULT_DEADLINE_MS };
}

/**
 * The same client with a shorter limit on each statement. One over the limit is
 * abandoned and fails as `unavailable`.
 */
export function withDeadline(db: DbClient, deadlineMs: number): DbClient {
  return db.open === undefined
    ? { orm: db.orm, deadlineMs }
    : { orm: db.orm, open: db.open, deadlineMs };
}

let client: DbClient | undefined;

/** One client for the life of the function instance, for handlers and the cron. */
export function getDb(): DbClient {
  const url = getDatabaseUrl();
  client ??= createDbClient(neonHttp(url), neonOpen(url));
  return client;
}

/** The client for a handler that has not deferred. See `INTERACTION_DEADLINE_MS`. */
export function getInteractionDb(): DbClient {
  return withDeadline(getDb(), INTERACTION_DEADLINE_MS);
}
