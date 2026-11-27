import type { EventCadence } from "@buzz/db";

/**
 * Recurring events. A series is a set of real `event` rows created together,
 * so this file is only the date arithmetic. "Same time each week" means the
 * same wall-clock time in Atlanta, not a fixed 7 x 24 hours: an 8 pm meeting
 * stays at 8 pm across the clocks changing.
 */

export const CHAPTER_ZONE = "America/New_York";

/** Most occurrences one series may create. */
export const MAX_OCCURRENCES = 26;

const DAY_MS = 24 * 60 * 60 * 1000;

const parts = new Intl.DateTimeFormat("en-US", {
  timeZone: CHAPTER_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

export type LocalTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function toLocal(date: Date): LocalTime {
  const get = Object.fromEntries(
    parts.formatToParts(date).map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  return {
    year: get.year!,
    month: get.month!,
    day: get.day!,
    hour: get.hour!,
    minute: get.minute!,
    second: get.second!,
  };
}

/** A wall-clock reading as if it were UTC. Used only to take differences. */
function asUtc(local: LocalTime) {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
}

/** The instant at which Atlanta's clock reads `local`. */
function fromLocal(local: LocalTime): Date {
  const wanted = asUtc(local);
  let guess = wanted;
  // Two passes settle the offset even when the guess lands across a change.
  for (let pass = 0; pass < 2; pass++) {
    const shown = asUtc(toLocal(new Date(guess)));
    guess += wanted - shown;
  }
  return new Date(guess);
}

/** `date` moved by whole calendar days, wall-clock time kept. */
export function addLocalDays(date: Date, days: number): Date {
  const local = toLocal(date);
  const moved = new Date(asUtc(local) + days * DAY_MS);
  return fromLocal({
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
    second: local.second,
  });
}

/**
 * The start times of a series. `count` occurrences, or as many as fit up to
 * and including `until`, never more than MAX_OCCURRENCES and always at least
 * the first.
 */
export function occurrenceStarts(
  first: Date,
  cadence: EventCadence,
  limit: { count: number } | { until: Date },
): Date[] {
  const step = cadence === "weekly" ? 7 : 14;
  const starts: Date[] = [];
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const start = i === 0 ? first : addLocalDays(first, i * step);
    if ("count" in limit) {
      if (i >= limit.count) break;
    } else if (i > 0 && start.getTime() > limit.until.getTime()) {
      break;
    }
    starts.push(start);
  }
  return starts;
}

/**
 * Applies the edit that turned `before` into `after` to another occurrence:
 * the same shift in calendar days, and the new time of day if it changed.
 */
export function shiftLike(target: Date, before: Date, after: Date): Date {
  const a = toLocal(before);
  const b = toLocal(after);
  const dayShift = Math.round(
    (asUtc({ ...b, hour: 0, minute: 0, second: 0 }) -
      asUtc({ ...a, hour: 0, minute: 0, second: 0 })) /
      DAY_MS,
  );
  const moved = addLocalDays(target, dayShift);
  const local = toLocal(moved);
  return fromLocal({
    ...local,
    hour: b.hour,
    minute: b.minute,
    second: b.second,
  });
}
