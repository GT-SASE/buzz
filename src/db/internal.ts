/**
 * Building and running statements. Lint keeps this file inside src/db/, so code
 * elsewhere holds a client and calls the functions there, but writes no SQL.
 */

import type { DbClient, Row } from "./client.ts";
import { failure, failureFromError, type DbResult } from "./errors.ts";
import type { CappedList } from "./types.ts";

/** A statement with its values as `$n` parameters. Only the `sql` tag makes one. */
export class Query {
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
 * The value of `select public.f(...) as value`. Write the whole statement, with each
 * argument named, so it reads on its own.
 */
export async function callFunction<T>(
  db: DbClient,
  statement: Query,
): Promise<DbResult<T>> {
  const rows = await query<{ value: T }>(db, statement);
  if (!rows.ok) {
    return rows;
  }
  const [row, ...others] = rows.value;
  return row === undefined || others.length > 0
    ? failure("unexpected")
    : { ok: true, value: row.value };
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
