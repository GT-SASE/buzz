/**
 * Checks made before any query. A failure here means no request is sent, and the
 * caller can refuse politely: Postgres would refuse NUL characters and lone surrogates
 * with an error.
 */

import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_INT4 = 2_147_483_647;
const MIN_DATE = "2000-01-01";
const MAX_DATE = "9999-12-31";

/** The most IDs one read may ask for. */
export const MAX_ID_LIST = 100;
/** Longest search term used, in code points. Longer input is cut to this. */
export const MAX_SEARCH_LENGTH = 100;
/** Discord's limit for a forum post title. */
export const MAX_EVENT_NAME_LENGTH = DISCORD_LIMITS.threadName;
/** The only copy: the table's check asks only for some text. */
export const MAX_TASK_DESCRIPTION_LENGTH = 1000;
export const MAX_TIMEZONE_LENGTH = 64;

const PICKUP_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

/** A time of day as `HH:MM`, 24-hour, the form the pickup time is written and read in. */
export function isPickupTime(value: unknown): value is string {
  return typeof value === "string" && PICKUP_TIME.test(value);
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

const ID_PREFIX = /^[0-9a-f]{1,8}$/;

/** The start of a UUID's first group, as the bot shows them: up to 8 lowercase hex digits. */
export function isIdPrefix(value: unknown): value is string {
  return typeof value === "string" && ID_PREFIX.test(value);
}

/** The first and last UUID starting with a prefix that `isIdPrefix` has accepted. */
export function idPrefixRange(prefix: string): { low: string; high: string } {
  return {
    low: `${prefix.padEnd(8, "0")}-0000-0000-0000-000000000000`,
    high: `${prefix.padEnd(8, "f")}-ffff-ffff-ffff-ffffffffffff`,
  };
}

export function isSearchTerm(value: unknown): value is string {
  return typeof value === "string" && isStorableString(value);
}

/**
 * A pattern for `ilike` that matches the term literally anywhere in the column.
 * Every `%`, `_` and backslash in the term is escaped, backslash being the default
 * escape character of LIKE. The pattern is sent as a parameter like any other value.
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
  return `%${capped.replace(/[\\%_]/g, "\\$&")}%`;
}
