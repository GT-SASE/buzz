/**
 * Checks on what a person or a post's title says an event is called and when it is.
 * Both run before any query, so hostile text gets a plain refusal and never reaches
 * the database or Discord.
 */

import {
  containsInviteOrMaskedLink,
  DISCORD_LIMITS,
  plainLabel,
  plainTextValue,
  safe,
  SafeTextError,
} from "../discord/safe-text.ts";
import type { PlainText, SafeText } from "../discord/safe-text.ts";
import {
  isDbDate,
  isPickupTime,
  isStoredText,
  MAX_EVENT_NAME_LENGTH,
} from "../db/validate.ts";
import { parseDateInput, todayInZone } from "../lib/dates.ts";
import type { DateOnly } from "../lib/dates.ts";

/** Longest date worth reading: `2026-11-15` with room for stray spaces. */
const MAX_DATE_INPUT_LENGTH = 32;

export interface EventName {
  /** What is stored. It is the same text as the post's title. */
  readonly name: string;
  readonly title: PlainText;
}

/**
 * The strict form of an event name: one line of letters, marks, numbers, emoji and a
 * few harmless marks. It holds no mention, link, domain, markdown or invisible text,
 * and the same rule applies to a name typed here and to the title of a post being
 * linked. Undefined if the text cannot be stored or nothing usable remains.
 *
 * NUL characters, lone surrogates and text too long for the column are refused rather
 * than cleaned. Normalising a result gives the same result.
 */
export function normaliseEventName(raw: unknown): EventName | undefined {
  if (!isStoredText(raw, MAX_EVENT_NAME_LENGTH)) {
    return undefined;
  }
  try {
    const title = plainLabel(raw, DISCORD_LIMITS.threadName);
    const name = plainTextValue(title);
    return isStoredText(name, MAX_EVENT_NAME_LENGTH)
      ? { name, title }
      : undefined;
  } catch (error) {
    if (error instanceof SafeTextError) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether a name as typed, or a post's title, holds a server invite or a masked link.
 * The stored name could never keep one, since `normaliseEventName` drops the `.`, `/`
 * and brackets they need, but a name that meant one is refused rather than quietly
 * turned into something else. The same check guards task descriptions.
 */
export function hasInviteOrMaskedLink(raw: unknown): boolean {
  return typeof raw === "string" && containsInviteOrMaskedLink(raw);
}

export type EventDateResult =
  | { readonly ok: true; readonly date: DateOnly }
  | { readonly ok: false; readonly problem: SafeText };

const BAD_DATE = safe`That date isn't valid. Use YYYY\\-MM\\-DD, or MM/DD for the next time that day comes round.`;
const PAST_DATE = safe`That date has already passed. Choose today or a later date.`;

/** A date in the guild's own time zone, from today onwards. */
export function parseEventDate(
  raw: unknown,
  timeZone: string,
  now: Date = new Date(),
): EventDateResult {
  if (typeof raw !== "string" || raw.length > MAX_DATE_INPUT_LENGTH) {
    return { ok: false, problem: BAD_DATE };
  }
  const parsed = parseDateInput(raw, {
    today: todayInZone(now, timeZone),
    rejectPast: true,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      problem: parsed.error === "past_date" ? PAST_DATE : BAD_DATE,
    };
  }
  return isDbDate(parsed.date)
    ? { ok: true, date: parsed.date }
    : { ok: false, problem: BAD_DATE };
}

/** Longest pickup time worth reading: `12:30 p.m.` with room for stray spaces. */
export const MAX_PICKUP_INPUT_LENGTH = 16;

export type PickupTimeResult =
  | { readonly ok: true; readonly time: string }
  | { readonly ok: false; readonly problem: SafeText };

const BAD_TIME = safe`Enter the pickup time like 5:30 PM, or on a 24-hour clock like 17:30.`;
const TWELVE_HOUR = /^(1[0-2]|0?[1-9])(?::([0-5][0-9]))? ?([ap])\.? ?m\.?$/;
const TWENTY_FOUR_HOUR = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/**
 * A wall-clock time on the event's day, in the guild's own time zone, as the `HH:MM`
 * the database stores. Takes "5:30 PM", "5pm", "5:30 p.m." or "17:30". A time with no
 * AM or PM needs a two-digit hour, so "5:30" is refused rather than guessed.
 */
export function parsePickupTime(raw: unknown): PickupTimeResult {
  if (typeof raw !== "string" || raw.length > MAX_PICKUP_INPUT_LENGTH) {
    return { ok: false, problem: BAD_TIME };
  }
  const text = raw.trim().toLowerCase().replace(/\s+/g, " ");
  const twelve = TWELVE_HOUR.exec(text);
  const twentyFour = TWENTY_FOUR_HOUR.exec(text);
  let time: string | undefined;
  if (twelve !== null) {
    const [, hour = "", minutes = "00", half] = twelve;
    const hours = (Number(hour) % 12) + (half === "p" ? 12 : 0);
    time = `${String(hours).padStart(2, "0")}:${minutes}`;
  } else if (twentyFour !== null) {
    time = text;
  }
  return isPickupTime(time)
    ? { ok: true, time }
    : { ok: false, problem: BAD_TIME };
}
