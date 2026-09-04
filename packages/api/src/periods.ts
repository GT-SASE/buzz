/**
 * Atlanta-local reporting windows, shared by the routers that report over one.
 * Moved out of the chapter router so member metrics cannot drift on when a
 * school year starts.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ATLANTA = "America/New_York";

export type Period = "30d" | "90d" | "semester" | "all";

function atlantaParts(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ATLANTA,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") };
}

function atlantaOffsetMs(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ATLANTA,
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

/** Midnight on that Atlanta calendar day. */
function atlantaStartOfDay(year: number, month: number, day: number) {
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const once = new Date(guess.getTime() - atlantaOffsetMs(guess));
  return new Date(guess.getTime() - atlantaOffsetMs(once));
}

/** August 1st of the school year `now` falls in. */
export function schoolYearStart(now: Date) {
  const { year, month } = atlantaParts(now);
  return atlantaStartOfDay(month >= 8 ? year : year - 1, 8, 1);
}

export function periodSince(period: Period, now: Date): Date | null {
  if (period === "all") return null;
  if (period === "30d") return new Date(now.getTime() - 30 * DAY_MS);
  if (period === "90d") return new Date(now.getTime() - 90 * DAY_MS);
  return schoolYearStart(now);
}
