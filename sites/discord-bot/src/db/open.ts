/**
 * Runs a write on a connection opened for it and closed after, and kills that connection
 * if the caller gives up, so the server rolls the transaction back and frees its locks
 * rather than letting it run on and commit after the caller was told it failed.
 */

import type { BotDb, DbClient } from "./client.ts";

/** A connection with Drizzle on it, and the two ways to end it. */
export interface WriteConnection {
  readonly orm: BotDb;
  /** Ends the connection after a finished write. */
  close(): Promise<void>;
  /** Drops the connection now, whatever it is doing. */
  destroy(): void;
}

/**
 * The statement timeout a write's connection is given, set once per connection. The server
 * then cancels a statement that outlives the caller's deadline, which dropping the
 * connection alone would not: a backend in a long statement does not notice the socket
 * closing until the statement ends.
 */
export function statementTimeoutSql(deadlineMs: number): string {
  return `SELECT set_config('statement_timeout', '${String(Math.trunc(deadlineMs))}ms', false)`;
}

export function openOn(
  connect: (deadlineMs: number) => Promise<WriteConnection>,
): NonNullable<DbClient["open"]> {
  return async (work, { signal, deadlineMs }) => {
    signal.throwIfAborted();
    const connection = await connect(deadlineMs);
    const drop = (): void => {
      connection.destroy();
    };
    if (signal.aborted) {
      drop();
      signal.throwIfAborted();
    }
    signal.addEventListener("abort", drop, { once: true });
    try {
      return await work(connection.orm);
    } finally {
      signal.removeEventListener("abort", drop);
      if (!signal.aborted) {
        await connection.close().catch(() => undefined);
      }
    }
  };
}
