/**
 * Building and running statements, and the transactions writes run in. Lint keeps this
 * file inside src/db/, so code elsewhere holds a client and calls the functions there,
 * but writes no SQL.
 */

import type { BotDb, BotTx, DbClient, Row } from "./client.ts";
import { failure, failureFromError, type DbResult } from "./errors.ts";
import type { CappedList } from "./types.ts";

/** A statement with its values as `$n` parameters. Only the `sql` tag makes one. */
class Query {
  readonly text: string;
  readonly params: readonly unknown[];

  constructor(strings: TemplateStringsArray, values: readonly unknown[]) {
    let text = strings[0] ?? "";
    const params: unknown[] = [];
    values.forEach((value, index) => {
      if (value instanceof Query) {
        if (value.params.length > 0) {
          throw new TypeError(
            "A fragment written into a statement takes no values",
          );
        }
        text += value.text;
      } else {
        params.push(value);
        text += `$${String(params.length)}`;
      }
      text += strings[index + 1] ?? "";
    });
    this.text = text;
    this.params = params;
  }
}

/**
 * sql`select ... where id = ${id}`: every value becomes a parameter, never text. A value
 * that is itself a sql`...` fragment with no values, such as a list of columns, is
 * written in place.
 */
export function sql(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Query {
  return new Query(strings, values);
}

/**
 * Runs one statement. One still running at the client's deadline is abandoned and fails
 * as `unavailable`: the request is aborted, though the database may still finish it, up
 * to the role's statement_timeout. Nothing is ever sent twice.
 */
export async function query<T = Row>(
  db: DbClient,
  statement: Query,
): Promise<DbResult<T[]>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<DbResult<T[]>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure("unavailable"));
    }, db.deadlineMs);
  });
  const outcome = db
    .run(statement.text, statement.params, controller.signal)
    .then(
      (rows): DbResult<T[]> => ({ ok: true, value: rows as T[] }),
      failureFromError,
    );
  try {
    return await Promise.race([outcome, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the database's own checks raise, raised from TypeScript. It carries a SQLSTATE and
 * a severity as a server error does, so `failureFromError` reads it the same way, and
 * throwing it inside a transaction rolls the transaction back.
 */
class RaisedError extends Error {
  readonly severity = "ERROR";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Fails the transaction it is thrown in, as RAISE EXCEPTION did, with a SQLSTATE. */
export function raise(code: string, message: string): never {
  throw new RaisedError(code, message);
}

/**
 * Runs `work`, abandoning it at the client's deadline as `query` does. One abandoned
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

/** One write statement built with Drizzle, which needs no transaction around it. */
export function write<T>(
  db: DbClient,
  work: (orm: BotDb) => Promise<T>,
): Promise<DbResult<T>> {
  return withinDeadline(db, (signal) =>
    db.open === undefined
      ? work(db.orm)
      : db.open(work, { signal, deadlineMs: db.deadlineMs }),
  );
}

/**
 * A write in a transaction, as a database function used to be: it takes its row locks, checks
 * what it read and writes, all or nothing. Throw `raise(...)` to refuse. The quota
 * triggers need the default isolation, read committed, so none is set here.
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

/** The rows of a raw statement run through Drizzle, whichever driver ran it. */
export function rowsOf<T = Row>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
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
