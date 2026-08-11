import { count, max, min, sum } from "drizzle-orm";

import { eventCheckIns } from "@buzz/db";

/**
 * Shared Drizzle aggregate expressions for member totals. Kept in one place so
 * event / member / chapter routers cannot drift on how points or attendance
 * are counted. Null sums are coerced to 0 at the call site via `asInt`.
 */

/** `count(eventCheckIns.id)`, never `count(*)`, under a LEFT JOIN. */
export const checkInCount = count(eventCheckIns.id);

export const pointsSum = sum(eventCheckIns.pointsEarned);

export const memberSince = min(eventCheckIns.checkedInAt);

export const lastCheckInAt = max(eventCheckIns.checkedInAt);

/** Normalize driver Date / string / numeric aggregates for the UI. */
export function asDate(value: Date | string | null | undefined) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function asInt(value: number | string | null | undefined) {
  if (value == null) return 0;
  return typeof value === "number" ? value : Number(value);
}

/** @deprecated use asDate */
export const toDate = asDate;

export const totalsColumns = {
  totalEvents: count(),
  totalPoints: sum(eventCheckIns.pointsEarned),
  memberSince,
} as const;
