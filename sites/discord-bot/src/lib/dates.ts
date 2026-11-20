/**
 * Calendar dates with no time of day. Deadlines are whole days in a guild's time
 * zone, so they are kept as YYYY-MM-DD strings, the form Postgres returns for a
 * `date` column. Zero-padded values also compare correctly as strings.
 */
export type DateOnly = string & { readonly __brand: "DateOnly" };

export type DateParseError = "invalid_format" | "invalid_date" | "past_date";

export type DateParseResult =
  { ok: true; date: DateOnly } | { ok: false; error: DateParseError };

export interface DateParseOptions {
  today: DateOnly;
  rejectPast?: boolean;
}

const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MONTH_DAY = /^([0-9]{1,2})\/([0-9]{1,2})$/;
const ANY_LEAP_YEAR = 2000;
const MAX_YEAR = 9999;

// setUTCFullYear, because Date.UTC reads years 0 to 99 as 1900 to 1999.
function utcDate(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = utcDate(year, month, day);
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDate(year: number, month: number, day: number): DateOnly {
  const yyyy = String(year).padStart(4, "0");
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}` as DateOnly;
}

/**
 * The calendar date at an instant in the given IANA time zone. Throws a
 * RangeError if the zone is unknown or the instant is invalid.
 */
export function todayInZone(now: Date, timeZone: string): DateOnly {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return formatDate(part("year"), part("month"), part("day"));
}

/**
 * Whether reminders can work out today's date in a zone. Postgres and this runtime keep
 * separate lists, so a zone the database accepts can still fail here. `Factory` means
 * no real place, and whether a runtime accepts it depends on its version, so it is
 * refused by name.
 */
export function isUsableTimeZone(timeZone: string): boolean {
  if (timeZone.toLowerCase() === "factory") {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function epochMs(date: DateOnly): number {
  const [year = 0, month = 0, day = 0] = date.split("-").map(Number);
  return utcDate(year, month, day).getTime();
}

/** How far the zone's clock is ahead of UTC at this instant, in milliseconds, to the whole second. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const clock =
    utcDate(part("year"), part("month"), part("day")).getTime() +
    ((part("hour") % 24) * 3600 + part("minute") * 60 + part("second")) * 1000;
  return clock - instant;
}

/**
 * The instant at which a zone's clock reads this time on this date, using the offset in
 * force on that date, so it stays right across a daylight saving change. A time the
 * clocks skip comes out an hour early, and a time they show twice gives the first.
 * Throws a RangeError for a zone the runtime does not know.
 */
export function instantInZone(
  date: DateOnly,
  hours: number,
  minutes: number,
  timeZone: string,
): number {
  const clock = epochMs(date) + (hours * 60 + minutes) * 60_000;
  const guess = clock - zoneOffsetMs(clock, timeZone);
  return clock - zoneOffsetMs(guess, timeZone);
}

/** Whole days from `from` to `to`: positive when `to` is later. */
export function daysBetween(from: DateOnly, to: DateOnly): number {
  return (epochMs(to) - epochMs(from)) / MS_PER_DAY;
}

/** Reads a strict YYYY-MM-DD value, or returns null if it is not a real date. */
export function parseIsoDate(value: string): DateOnly | null {
  const match = ISO_DATE.exec(value);
  if (match === null) {
    return null;
  }
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  return isCalendarDate(year, month, day) ? formatDate(year, month, day) : null;
}

// Feb 29 can be up to eight years away, as 2096 to 2104 skips the year 2100.
function nextOccurrence(month: number, day: number, today: DateOnly): DateOnly {
  if (parseIsoDate(today) === null) {
    throw new RangeError("today must be a real YYYY-MM-DD date");
  }
  let year = Number(today.slice(0, 4));
  while (
    !isCalendarDate(year, month, day) ||
    formatDate(year, month, day) < today
  ) {
    year += 1;
    // A fifth year digit would break the string comparison above.
    if (year > MAX_YEAR) {
      throw new RangeError("no occurrence before the year 10000");
    }
  }
  return formatDate(year, month, day);
}

/**
 * Parses a date typed by a user: `2026-11-15`, or `11/15` for the next time that
 * month and day come round, counting today.
 */
export function parseDateInput(
  input: string,
  { today, rejectPast = false }: DateParseOptions,
): DateParseResult {
  const text = input.trim();
  const monthDay = MONTH_DAY.exec(text);

  let date: DateOnly | null = null;
  if (monthDay !== null) {
    const [month, day] = [Number(monthDay[1]), Number(monthDay[2])];
    if (isCalendarDate(ANY_LEAP_YEAR, month, day)) {
      date = nextOccurrence(month, day, today);
    }
  } else if (ISO_DATE.test(text)) {
    date = parseIsoDate(text);
  } else {
    return { ok: false, error: "invalid_format" };
  }

  if (date === null) {
    return { ok: false, error: "invalid_date" };
  }
  if (rejectPast && date < today) {
    return { ok: false, error: "past_date" };
  }
  return { ok: true, date };
}
