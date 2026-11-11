/** Turns PostgREST responses into results, with the row counts each caller expects. */

import { failure, failureFromResponse, type DbResult } from "./errors.ts";
import type { ExcludedRow, RowParser } from "./types.ts";
import { isUuid } from "./validate.ts";

/** The parts of a response read here. `data` stays unknown until it is parsed. */
export interface ApiResponse {
  readonly data: unknown;
  readonly error: unknown;
  readonly status: number;
}

export interface RowList<T> {
  readonly rows: T[];
  /** Rows that failed their checks. Callers should log these: they hold no row text. */
  readonly excluded: ExcludedRow[];
}

function responseRows(response: ApiResponse): DbResult<readonly unknown[]> {
  if (response.error !== null) {
    return failureFromResponse(response.error, response.status);
  }
  const { data } = response;
  return Array.isArray(data)
    ? { ok: true, value: data as readonly unknown[] }
    : failure("bad_row");
}

export interface CappedList<T> extends RowList<T> {
  /** True if the database held more rows than the cap, so this list is not all of them. */
  readonly truncated: boolean;
}

function parseAll<T>(raw: readonly unknown[], parse: RowParser<T>): RowList<T> {
  const rows: T[] = [];
  const excluded: ExcludedRow[] = [];
  for (const item of raw) {
    const parsed = parse(item);
    if (parsed.ok) {
      rows.push(parsed.row);
    } else {
      excluded.push(parsed.excluded);
    }
  }
  return { rows, excluded };
}

export function rowList<T>(
  response: ApiResponse,
  parse: RowParser<T>,
): DbResult<RowList<T>> {
  const raw = responseRows(response);
  return raw.ok ? { ok: true, value: parseAll(raw.value, parse) } : raw;
}

/** For a query that asked for `cap + 1` rows. The extra row only shows there are more. */
export function cappedList<T>(
  response: ApiResponse,
  parse: RowParser<T>,
  cap: number,
): DbResult<CappedList<T>> {
  const raw = responseRows(response);
  if (!raw.ok) {
    return raw;
  }
  return {
    ok: true,
    value: {
      ...parseAll(raw.value.slice(0, cap), parse),
      truncated: raw.value.length > cap,
    },
  };
}

/** A read by key: at most one row. A row that fails its checks is a `bad_row` failure. */
export function oneOrNone<T>(
  response: ApiResponse,
  parse: RowParser<T>,
): DbResult<T | null> {
  const list = rowList(response, parse);
  if (!list.ok) {
    return list;
  }
  const { rows, excluded } = list.value;
  if (excluded.length > 0 || rows.length > 1) {
    return failure("bad_row");
  }
  return { ok: true, value: rows[0] ?? null };
}

/**
 * A write that must change exactly one row. No match is `not_found`, covering a row
 * that is absent, in another guild, or no longer meets the write's conditions.
 */
export function exactlyOne<T>(
  response: ApiResponse,
  parse: RowParser<T>,
): DbResult<T> {
  const raw = responseRows(response);
  if (!raw.ok) {
    return raw;
  }
  const [first, ...others] = raw.value;
  if (first === undefined) {
    return failure("not_found");
  }
  if (others.length > 0) {
    return failure("unexpected");
  }
  const parsed = parse(first);
  return parsed.ok ? { ok: true, value: parsed.row } : failure("bad_row");
}

/** A write that returns nothing. Its only outcomes are success and a refusal. */
export function noRows(response: ApiResponse): DbResult<null> {
  return response.error === null
    ? { ok: true, value: null }
    : failureFromResponse(response.error, response.status);
}

export function booleanValue(response: ApiResponse): DbResult<boolean> {
  if (response.error !== null) {
    return failureFromResponse(response.error, response.status);
  }
  return typeof response.data === "boolean"
    ? { ok: true, value: response.data }
    : failure("bad_row");
}

export function integerValue(response: ApiResponse): DbResult<number> {
  if (response.error !== null) {
    return failureFromResponse(response.error, response.status);
  }
  return typeof response.data === "number" &&
    Number.isSafeInteger(response.data)
    ? { ok: true, value: response.data }
    : failure("bad_row");
}

export function nullableUuidValue(
  response: ApiResponse,
): DbResult<string | null> {
  if (response.error !== null) {
    return failureFromResponse(response.error, response.status);
  }
  return response.data === null || isUuid(response.data)
    ? { ok: true, value: response.data }
    : failure("bad_row");
}
