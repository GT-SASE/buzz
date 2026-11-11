/**
 * Checks made before any query. A failure here means no request is sent. Postgres
 * refuses NUL characters and lone surrogates with an error, and `.in()` does not
 * escape an embedded double quote, so bad values must stop at this point.
 */

import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INT4 = 2_147_483_647;
const MIN_DATE = "2000-01-01";
const MAX_DATE = "9999-12-31";

/** The most IDs one `.in()` filter may carry. */
export const MAX_ID_LIST = 100;
/** Longest search term used, in code points. Longer input is cut to this. */
export const MAX_SEARCH_LENGTH = 100;
/** Discord's limit for a forum post title. */
export const MAX_EVENT_NAME_LENGTH = 100;
export const MAX_TASK_DESCRIPTION_LENGTH = 1000;
export const MAX_TIMEZONE_LENGTH = 64;

const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/;

/** A timestamp in the form the API returns it, safe to send back in a filter. */
export function isTimestampText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMP.test(value) &&
    !Number.isNaN(new Date(value).getTime())
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isStorableString(value: string): boolean {
  return !value.includes("\0") && value.isWellFormed();
}

/**
 * Text for a column, non-blank and within `max` UTF-16 code units. The database
 * counts code points, but Discord's limits are stricter for astral characters, and
 * text that fits here always fits the column.
 */
export function isStoredText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    value.trim() !== "" &&
    isStorableString(value)
  );
}

/** A real calendar date inside the range the date columns accept. */
export function isDbDate(value: unknown): value is DateOnly {
  return (
    typeof value === "string" &&
    parseIsoDate(value) === value &&
    value >= MIN_DATE &&
    value <= MAX_DATE
  );
}

export function isVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_INT4
  );
}

export function isInstant(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function isSnowflakeList(
  values: readonly unknown[],
  max: number = MAX_ID_LIST,
): values is readonly string[] {
  return (
    Array.isArray(values) && values.length <= max && values.every(isSnowflake)
  );
}

function checkedList(
  values: readonly string[],
  isValid: (value: unknown) => boolean,
): string[] {
  if (values.length > MAX_ID_LIST || !values.every(isValid)) {
    throw new RangeError("ID list failed validation");
  }
  return [...values];
}

/**
 * The only way to give `.in()` a list of Discord IDs, which lint enforces. Callers
 * check first and refuse politely, so this throwing means a missed check.
 */
export function snowflakeList(values: readonly string[]): string[] {
  return checkedList(values, isSnowflake);
}

/** The only way to give `.in()` a list of UUIDs. See `snowflakeList`. */
export function uuidList(values: readonly string[]): string[] {
  return checkedList(values, isUuid);
}

const ID_PREFIX = /^[0-9a-f]{1,8}$/;

/** The start of a UUID's first group, as the bot shows them: up to 8 lowercase hex digits. */
export function isIdPrefix(value: unknown): value is string {
  return typeof value === "string" && ID_PREFIX.test(value);
}

/** The first and last UUID starting with a prefix that `isIdPrefix` has accepted. */
export function idPrefixRange(prefix: string): { low: string; high: string } {
  if (!isIdPrefix(prefix)) {
    throw new RangeError("ID prefix failed validation");
  }
  return {
    low: `${prefix.padEnd(8, "0")}-0000-0000-0000-000000000000`,
    high: `${prefix.padEnd(8, "f")}-ffff-ffff-ffff-ffffffffffff`,
  };
}

export function isSearchTerm(value: unknown): value is string {
  return typeof value === "string" && isStorableString(value);
}

/**
 * A pattern for `.ilike()` that matches the term literally anywhere in the column.
 * Every `%`, `_`, `*` and backslash in the term is escaped.
 *
 * PostgREST turns every `*` in a pattern into `%` with no way to escape it, so `\*`
 * reaches Postgres as `\%`, a literal percent sign. A term with `*` therefore cannot
 * find a literal asterisk, but it can never widen the match.
 */
export function searchPattern(term: string): string {
  let capped = "";
  let codePoints = 0;
  // Iterating a string goes by code point, so this never splits a surrogate pair.
  for (const character of term) {
    if (codePoints === MAX_SEARCH_LENGTH) {
      break;
    }
    capped += character;
    codePoints += 1;
  }
  return `%${capped.replace(/[\\%_*]/g, "\\$&")}%`;
}

/**
 * The only way to give `.or()` a value, which lint enforces: rows after a position
 * in `due_date, id` order. Both parts are checked, so no text can change the filter.
 */
export function keysetAfter(dueDate: string, id: string): string {
  if (!isDbDate(dueDate) || !isUuid(id)) {
    throw new RangeError("Page position failed validation");
  }
  return `due_date.gt.${dueDate},and(due_date.eq.${dueDate},id.gt.${id})`;
}
