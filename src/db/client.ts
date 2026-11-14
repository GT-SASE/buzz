/**
 * The database client: something that runs one statement, and how long a statement may
 * take. Production builds it on first use, so importing this file reads no setting.
 */

import { getDatabaseUrl } from "../lib/env.ts";
import { neonRunner } from "./neon.ts";

/** A row as the driver returns it, with the column types read as `TYPE_PARSERS` says. */
export type Row = Record<string, unknown>;

/** Sends one statement with `$n` parameters and returns its rows. */
export type Runner = (
  text: string,
  params: readonly unknown[],
  signal: AbortSignal,
) => Promise<Row[]>;

export interface DbClient {
  readonly run: Runner;
  readonly deadlineMs: number;
}

const DEFAULT_DEADLINE_MS = 8000;

/**
 * For a request Discord is waiting on. Discord allows 3 seconds for the first reply.
 * The read has to fit a cold function and a Neon compute waking from suspend, and
 * still leave time for a fixed reply if it fails. An interaction handler makes one
 * such read and defers anything more.
 */
export const INTERACTION_DEADLINE_MS = 2200;

/** A client on Neon in production, or PGlite or pg in tests. */
export function createDbClient(run: Runner): DbClient {
  return { run, deadlineMs: DEFAULT_DEADLINE_MS };
}

/**
 * The same client with a shorter limit on each statement. One over the limit is
 * abandoned and fails as `unavailable`.
 */
export function withDeadline(db: DbClient, deadlineMs: number): DbClient {
  return { run: db.run, deadlineMs };
}

let client: DbClient | undefined;

/** One client for the life of the function instance, for handlers and the cron. */
export function getDb(): DbClient {
  client ??= createDbClient(neonRunner(getDatabaseUrl()));
  return client;
}

/** The client for a handler that has not deferred. See `INTERACTION_DEADLINE_MS`. */
export function getInteractionDb(): DbClient {
  return withDeadline(getDb(), INTERACTION_DEADLINE_MS);
}
