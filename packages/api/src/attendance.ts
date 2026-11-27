import { and, gte, inArray, isNull, lt, sql } from "drizzle-orm";

import { events, pointsLedger } from "@buzz/db";

/**
 * The one definition of "event points in a period", read from the points
 * ledger: the attendance rows net of removals, on events that are not
 * archived, in the window the event started in. The leaderboard and the
 * member card both build their totals from these, so the two cannot disagree.
 *
 * A check-in belongs to the window of its event, not of the ledger row, so a
 * removal logged next semester still nets against the grant it undoes.
 */
const ATTENDANCE_SOURCES = [
  "check_in",
  "manual_check_in",
  "check_in_removed",
] as const;

export function attendanceFilter(window: { from: Date; to: Date } | null) {
  return and(
    inArray(pointsLedger.source, [...ATTENDANCE_SOURCES]),
    isNull(events.archivedAt),
    window ? gte(events.startsAt, window.from) : undefined,
    window ? lt(events.startsAt, window.to) : undefined,
  );
}

export const attendancePoints = sql<number>`sum(${pointsLedger.delta})`;

/** Grants minus removals: each check-in is one row, each removal one more. */
export const attendanceEvents = sql<number>`sum(case when ${pointsLedger.source} = 'check_in_removed' then -1 else 1 end)`;
