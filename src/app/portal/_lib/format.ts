/**
 * Portal date formatting.
 *
 * The time zone is pinned to Atlanta rather than left to the runtime: these
 * strings render on the server and again in the browser, and a member on a
 * laptop still set to another zone would otherwise see a different start time
 * than the one printed on the poster.
 */
const ZONE = "America/New_York";

const dateAndTime = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ZONE,
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: ZONE,
});

export function formatEventTime(value: Date) {
  return dateAndTime.format(value);
}

export function formatDate(value: Date) {
  return dateOnly.format(value);
}

/** For a datetime-local input, which wants "YYYY-MM-DDTHH:mm" in Atlanta time. */
export function toLocalInputValue(value: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: ZONE,
  }).formatToParts(value);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** How far ahead of UTC the zone was at a given instant, in milliseconds. */
function zoneOffsetMs(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  const asIfUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );

  return asIfUtc - at.getTime();
}

/**
 * The inverse of `toLocalInputValue`.
 *
 * A `datetime-local` input hands back a bare wall clock with no zone, and
 * `new Date(...)` on it would resolve against whatever zone the officer's
 * laptop is set to. Everything here is Atlanta time, so the typed value is
 * interpreted as Atlanta and converted to a real instant. The second pass
 * settles the two hours a year when the offset changes across the guess.
 */
export function fromLocalInputValue(value: string) {
  const guess = new Date(`${value}:00Z`);
  const once = new Date(guess.getTime() - zoneOffsetMs(guess));
  return new Date(guess.getTime() - zoneOffsetMs(once));
}
