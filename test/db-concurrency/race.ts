import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  HOOK_TIMEOUT_MS,
  pgConnection,
  type Connection,
} from "../db/harness.ts";
import { pgSql } from "../support/sql-client.ts";
import {
  botUrlForDatabase,
  concurrencyContext,
  urlForDatabase,
} from "./global-setup.ts";

/**
 * Races between real connections, which PGlite cannot run because it has only one.
 * Each test has T1, a connection logged in as bot_app, hold a transaction open. The
 * second side is usually the bot itself: a function from src/db, sending the same
 * statements as in production, through a pg pool logged in as bot_app. The race proves
 * through pg_blocking_pids that the bot's query waits on T1, then lets T1 finish and
 * returns what the bot got. T2 and any further connection are also bot_app, for races
 * that need to know exactly which connection waits on which.
 */

const BLOCK_TIMEOUT_MS = 10_000;

export interface Outcome {
  rows?: Record<string, unknown>[];
  code?: string | undefined;
}

export type Statement = [sql: string, params: unknown[]];

export interface RaceDatabase {
  /** A connection outside the race, as the superuser, for setup and checks. */
  readonly observer: pg.Client;
  /** The observer, in the shape test/db/fixtures.ts takes. */
  readonly connection: Connection;
  /** The bot's own client, logged in as bot_app. */
  readonly db: DbClient;
  /** A connection logged in as bot_app, for statements the bot never sends. */
  readonly t1: pg.Client;
  /** A second bot_app connection, for races between two known connections. */
  readonly t2: pg.Client;
  /**
   * Waits until the waiter is blocked by the blocker, T1 unless told otherwise, and fails
   * if that never happens. With no waiter, any bot_app backend will do, such as the
   * bot's pooled connection. Both must be connections this database opened.
   */
  waitUntilBlocked(waiter?: pg.Client, blocker?: pg.Client): Promise<void>;
  /**
   * T1 runs its statement in an open transaction, the bot's call runs and must block,
   * then T1 finishes. Returns what the bot's call returned.
   */
  race<T>(
    first: Statement,
    second: (db: DbClient) => Promise<T>,
    finish?: "COMMIT" | "ROLLBACK",
  ): Promise<T>;
}

export function settled(query: Promise<pg.QueryResult>): Promise<Outcome> {
  return query.then(
    (result) => ({ rows: result.rows as Record<string, unknown>[] }),
    (error: unknown) => ({ code: (error as { code?: string }).code }),
  );
}

async function pidOf(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid",
  );
  const pid = rows[0]?.pid;
  if (typeof pid !== "number") {
    throw new Error("pg_backend_pid returned no number");
  }
  return pid;
}

/**
 * Gives the calling file a database of its own, copied from the migrated template that
 * global-setup.ts made, the bot's client on it, and two fresh bot_app connections for
 * each test, with more on request.
 */
export function raceDatabase(): RaceDatabase {
  const { adminUrl, template, botPassword } = concurrencyContext();
  const databaseName = `concurrency_${randomBytes(6).toString("hex")}`;
  const databaseUrl = urlForDatabase(adminUrl, databaseName);
  const botUrl = botUrlForDatabase(adminUrl, databaseName, botPassword);

  let observer: pg.Client | undefined;
  let bot: DbClient | undefined;
  let t1: pg.Client | undefined;
  let t2: pg.Client | undefined;
  // Every connection open for the current test, with its backend pid.
  const pids = new Map<pg.Client, number>();
  // Filled in as setup goes, so that a setup failure still cleans up what it made.
  const cleanups: (() => Promise<unknown>)[] = [];

  const ready = <T>(value: T | undefined): T => {
    if (value === undefined) {
      throw new Error("the race database is not set up");
    }
    return value;
  };

  beforeAll(async () => {
    const cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    cleanups.unshift(() => cluster.end());
    // The copy keeps the template's owner. The migrations revoke schema public from
    // PUBLIC, so the functions only reach it while their owner owns the database.
    const owner = await cluster.query<{ owner: string }>(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [template],
    );
    await cluster.query(
      `CREATE DATABASE ${databaseName} TEMPLATE ${template} OWNER ${pg.escapeIdentifier(owner.rows[0]?.owner ?? "")}`,
    );
    cleanups.unshift(() =>
      cluster.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`),
    );
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    observer = client;
    cleanups.unshift(() => client.end());
    const pool = new pg.Pool({ connectionString: botUrl });
    bot = createDbClient(pgSql(pool));
    cleanups.unshift(() => pool.end());
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }, HOOK_TIMEOUT_MS);

  async function connect(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: botUrl });
    await client.connect();
    try {
      // Read here, while the connection is idle. A query on a client that is already
      // blocked would queue behind the blocked statement and not return until the wait
      // was over.
      pids.set(client, await pidOf(client));
    } catch (error) {
      await client.end();
      throw error;
    }
    return client;
  }

  beforeEach(async () => {
    t1 = await connect();
    t2 = await connect();
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    const open = [...pids.keys()];
    pids.clear();
    t1 = undefined;
    t2 = undefined;
    for (const client of open) {
      await client.end();
    }
  }, HOOK_TIMEOUT_MS);

  function pidFor(client: pg.Client): number {
    const pid = pids.get(client);
    if (pid === undefined) {
      throw new Error("the connection is not one this race database opened");
    }
    return pid;
  }

  async function blockedOn(
    waiter: pg.Client | undefined,
    blockerPid: number,
  ): Promise<boolean> {
    if (waiter === undefined) {
      const { rows } = await ready(observer).query<{ blocked: number }>(
        `SELECT count(*)::int AS blocked FROM pg_stat_activity
         WHERE usename = 'bot_app' AND $1 = ANY (pg_blocking_pids(pid))`,
        [blockerPid],
      );
      return (rows[0]?.blocked ?? 0) > 0;
    }
    const { rows } = await ready(observer).query<{ blockers: number[] }>(
      "SELECT pg_blocking_pids($1) AS blockers",
      [pidFor(waiter)],
    );
    return rows[0]?.blockers.includes(blockerPid) ?? false;
  }

  async function waitUntilBlocked(
    waiter?: pg.Client,
    blocker: pg.Client = ready(t1),
  ): Promise<void> {
    const blockerPid = pidFor(blocker);
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await blockedOn(waiter, blockerPid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const who =
      waiter === undefined
        ? "no bot_app query"
        : `connection ${String(pidFor(waiter))}`;
    throw new Error(`${who} ever blocked on ${String(blockerPid)}`);
  }

  return {
    get observer() {
      return ready(observer);
    },
    get connection() {
      return pgConnection(ready(observer));
    },
    get db() {
      return ready(bot);
    },
    get t1() {
      return ready(t1);
    },
    get t2() {
      return ready(t2);
    },
    waitUntilBlocked,
    async race(first, second, finish = "COMMIT") {
      const one = ready(t1);
      await one.query("BEGIN");
      await one.query(first[0], first[1]);
      const outcome = second(ready(bot));
      try {
        await waitUntilBlocked();
      } finally {
        await one.query(finish);
      }
      return outcome;
    },
  };
}
