/**
 * Running statements through Drizzle, and the transactions writes run in. Lint keeps this
 * file inside src/db/, so code elsewhere holds a client and calls the functions there,
 * but builds no statements.
 */

import { sql, type SQL } from "drizzle-orm";
import type { BotDb, BotTx, DbClient } from "./client.ts";
import { failure, failureFromError, type DbResult } from "./errors.ts";
import type { CappedList } from "./types.ts";

/**
 * What the bot's own checks raise, as a database error would: a SQLSTATE and a severity,
 * so `failureFromError` reads it the same way. Throwing it inside a transaction rolls the
 * transaction back.
 */
class RaisedError extends Error {
  readonly severity = "ERROR";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Fails the transaction it is thrown in, with a SQLSTATE. */
export function raise(code: string, message: string): never {
  throw new RaisedError(code, message);
}

/**
 * Runs `work`, abandoning it at the client's deadline as a lost request is: the request
 * may still finish on the server, up to the role's statement and idle-in-transaction
 * timeouts, which roll a transaction back. Nothing is ever sent twice.
 *
 * A write that opened its own connection loses it at the deadline, so the server rolls
 * its transaction back and no COMMIT can follow; a statement already running is
 * cancelled by the statement timeout the connection was given. A caller that is told
 * `unavailable` may still have had a single statement land, as with any lost reply.
 */
async function withinDeadline<T>(
  db: DbClient,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<DbResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = new Promise<DbResult<T>>((resolve) => {
    timer = setTimeout(() => {
      // Aborting drops the write's connection, so its transaction rolls back.
      controller.abort();
      resolve(failure("unavailable"));
    }, db.deadlineMs);
  });
  const outcome = Promise.resolve()
    .then(() => work(controller.signal))
    .then((value): DbResult<T> => ({ ok: true, value }), failureFromError);
  try {
    return await Promise.race([outcome, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A single value computed by the server, such as a lock taken or a setting read, as a
 * select of one expression from a one-row source.
 */
export async function evaluate<T>(
  db: BotDb,
  expression: SQL<T>,
): Promise<T | undefined> {
  const [row] = await db
    .select({ value: expression })
    .from(sql`(values (1)) as one(x)`);
  return row?.value;
}

/** One read, or one write statement that needs no lock or transaction around it. */
export function read<T>(
  db: DbClient,
  work: (orm: BotDb) => Promise<T>,
): Promise<DbResult<T>> {
  return withinDeadline(db, () => work(db.orm));
}

/** One write statement built with Drizzle, which needs no transaction around it. */
export const write = read;

/**
 * A write in a transaction: it takes its row locks, checks what it read and writes, all
 * or nothing. Throw `raise(...)` to refuse. The quota checks need the default isolation,
 * read committed, so none is set here.
 */
export function transact<T>(
  db: DbClient,
  work: (tx: BotTx) => Promise<T>,
): Promise<DbResult<T>> {
  return withinDeadline(db, (signal) =>
    db.open === undefined
      ? db.orm.transaction(work)
      : db.open((orm) => orm.transaction(work), {
          signal,
          deadlineMs: db.deadlineMs,
        }),
  );
}

/** The first row, or null. For a read by key. */
export function firstRow<T>(rows: DbResult<T[]>): DbResult<T | null> {
  return rows.ok ? { ok: true, value: rows.value[0] ?? null } : rows;
}

/**
 * The one row a write changed. No match is `not_found`, covering a row that is absent,
 * in another guild, or no longer meets the write's conditions.
 */
export function changedRow<T>(rows: DbResult<T[]>): DbResult<T> {
  if (!rows.ok) {
    return rows;
  }
  const [row, ...others] = rows.value;
  if (row === undefined) {
    return failure("not_found");
  }
  return others.length > 0 ? failure("unexpected") : { ok: true, value: row };
}

/** For a read that asked for `cap + 1` rows. The extra row only shows there are more. */
export function capped<T>(
  rows: DbResult<T[]>,
  cap: number,
): DbResult<CappedList<T>> {
  return rows.ok
    ? {
        ok: true,
        value: {
          rows: rows.value.slice(0, cap),
          truncated: rows.value.length > cap,
        },
      }
    : rows;
}

/** A function's null answer means no live row matched. */
export function nullAsNotFound<T>(result: DbResult<T | null>): DbResult<T> {
  if (!result.ok) {
    return result;
  }
  return result.value === null
    ? failure("not_found")
    : { ok: true, value: result.value };
}
