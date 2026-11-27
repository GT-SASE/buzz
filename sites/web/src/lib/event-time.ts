import { EVENT_CALENDAR_LENGTH_MS } from "@buzz/api/event-length";

/**
 * Dates and times for the public calendar: the chapter's clock, the day keys
 * the month grid files events under, and the grid itself. Pure on purpose, so
 * the server pages, the .ics feed and the tests all read events the same way.
 *
 * Calendar days are `"YYYY-MM-DD"` strings and day arithmetic runs on those
 * strings through UTC, never on instants plus 24 hours: the chapter's zone
 * changes clocks twice a year, so a local day is sometimes 23 or 25 hours long.
 */

/** Every date and time the public site shows is read in this zone. */
export const CHAPTER_ZONE = "America/New_York";

/** An event stays on the calendar until it is a day old, then moves to past. */
export const EVENT_SETTLE_MS = 24 * 60 * 60 * 1000;

/** True once an event is a day old: where /events moves it to the archive. */
export function isSettled(event: { startsAt: Date }, now = new Date()) {
  return event.startsAt.getTime() < now.getTime() - EVENT_SETTLE_MS;
}

/** `"2026-11-24"`, a calendar day in the chapter's zone. */
type DateKey = string;
/** `"2026-11"`, a calendar month in the chapter's zone. */
export type MonthKey = string;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dayParts = new Intl.DateTimeFormat("en-US", {
  timeZone: CHAPTER_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The chapter-local calendar day an instant falls on. */
export function localDateKey(instant: Date): DateKey {
  const parts = Object.fromEntries(
    dayParts.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function utcOf(key: DateKey) {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day);
}

function keyOf(utc: number): DateKey {
  return new Date(utc).toISOString().slice(0, 10);
}

export function addDays(key: DateKey, days: number): DateKey {
  return keyOf(utcOf(key) + days * MS_PER_DAY);
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for `"YYYY-MM"` with a real month. */
export function isMonthKey(value: string): value is MonthKey {
  return MONTH_PATTERN.test(value);
}

export function monthKeyOf(instant: Date): MonthKey {
  return localDateKey(instant).slice(0, 7);
}

export function shiftMonth(month: MonthKey, by: number): MonthKey {
  const [year, number] = month.split("-").map(Number);
  const index = year! * 12 + (number! - 1) + by;
  const nextYear = Math.floor(index / 12);
  return `${String(nextYear).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** `"2026-11"` to `"November 2026"`. */
export function monthLabel(month: MonthKey) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  }).format(new Date(utcOf(`${month}-01`)));
}

/** `"2026-11-24"` to `"Tuesday, November 24"`. */
export function dayLabel(key: DateKey) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(new Date(utcOf(key)));
}

const longDate = new Intl.DateTimeFormat("en-US", {
  timeZone: CHAPTER_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: CHAPTER_ZONE,
  hour: "numeric",
  minute: "2-digit",
});

const clockWithZone = new Intl.DateTimeFormat("en-US", {
  timeZone: CHAPTER_ZONE,
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

/** `"Tuesday, November 24, 2026"`. */
export const formatLongDate = (instant: Date) => longDate.format(instant);

/** `"6:00 PM"`, for a grid cell where the zone is the page's, not the cell's. */
export const formatClock = (instant: Date) => clock.format(instant);

/** `"6:00 PM EST"`. */
export const formatClockWithZone = (instant: Date) =>
  clockWithZone.format(instant);

/** The slice of an event the grid and the feed need. */
export type SpanEvent = {
  id: string;
  title: string;
  startsAt: Date;
  /** Date-only listing: the stored time means nothing, so it spans its day. */
  reminder: boolean;
};

/** When an event ends. Events store a start only. */
export function eventEnd(event: Pick<SpanEvent, "startsAt">) {
  return new Date(event.startsAt.getTime() + EVENT_CALENDAR_LENGTH_MS);
}

/**
 * Every chapter-local day an event touches, first to last. A 90-minute event
 * that starts at 11:30 pm touches two. An end exactly at midnight does not
 * reach into the next day.
 */
export function eventDays(event: SpanEvent): DateKey[] {
  const first = localDateKey(event.startsAt);
  if (event.reminder) return [first];
  const last = localDateKey(new Date(eventEnd(event).getTime() - 1));
  const days = [first];
  while (days[days.length - 1]! < last) {
    days.push(addDays(days[days.length - 1]!, 1));
  }
  return days;
}

export type GridEntry<E extends SpanEvent> = {
  event: E;
  /** The day the event starts: show its time. Otherwise it runs on from before. */
  startsHere: boolean;
  /** The day the event ends: show when it finishes if it did not start here. */
  endsHere: boolean;
};

export type GridDay<E extends SpanEvent> = {
  key: DateKey;
  day: number;
  inMonth: boolean;
  entries: GridEntry<E>[];
};

/**
 * The weeks of one month, Sunday first, padded with the neighbouring months'
 * days so every row has seven cells. Only days inside the month carry events;
 * an event that runs past midnight into the month still lands on its first day.
 */
export function monthGrid<E extends SpanEvent>(
  month: MonthKey,
  events: readonly E[],
): GridDay<E>[][] {
  const byDay = new Map<DateKey, GridEntry<E>[]>();
  const sorted = [...events].sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  for (const event of sorted) {
    const days = eventDays(event);
    days.forEach((key, index) => {
      const entries = byDay.get(key) ?? [];
      entries.push({
        event,
        startsHere: index === 0,
        endsHere: index === days.length - 1,
      });
      byDay.set(key, entries);
    });
  }

  const first = `${month}-01`;
  const lead = new Date(utcOf(first)).getUTCDay();
  const lastDay = new Date(
    Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0),
  ).getUTCDate();
  const weeks = Math.ceil((lead + lastDay) / 7);

  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const key = addDays(first, week * 7 + weekday - lead);
      const inMonth = key.startsWith(month);
      return {
        key,
        day: Number(key.slice(8, 10)),
        inMonth,
        entries: inMonth ? (byDay.get(key) ?? []) : [],
      };
    }),
  );
}

/**
 * The months worth a page: from the earliest event to the latest, always
 * including the current one. Anything else is an empty month nobody linked to.
 */
export function monthBounds(
  events: readonly Pick<SpanEvent, "startsAt">[],
  now: Date,
): { first: MonthKey; last: MonthKey } {
  const current = monthKeyOf(now);
  let first = current;
  let last = current;
  for (const event of events) {
    const month = monthKeyOf(event.startsAt);
    if (month < first) first = month;
    if (month > last) last = month;
  }
  return { first, last };
}
