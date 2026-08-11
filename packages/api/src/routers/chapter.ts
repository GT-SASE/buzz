import {
  and,
  asc,
  count,
  countDistinct,
  eq,
  gte,
  isNull,
  lt,
} from "drizzle-orm";

import { asInt } from "../aggregates";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { eventCheckIns, events, users } from "@buzz/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const chapterRouter = createTRPCRouter({
  /** Chapter-wide numbers for the officer dashboard. Every figure via Drizzle. */
  overview: adminProcedure.query(async ({ ctx }) => {
    // One clock for the whole resolver: read twice, the 30-day window and the
    // past/upcoming split can land either side of a tick and disagree.
    const now = new Date();
    const since = new Date(now.getTime() - THIRTY_DAYS_MS);

    const [
      [memberTotals],
      [checkInTotals],
      [checkInsLast30],
      [liveEvents],
      [pastEvents],
      [upcomingEvents],
      [pastAttendance],
      next,
    ] = await Promise.all([
      ctx.db.select({ total: count() }).from(users),
      ctx.db
        .select({
          total: count(),
          withCheckIns: countDistinct(eventCheckIns.userId),
        })
        .from(eventCheckIns)
        .innerJoin(events, eq(events.id, eventCheckIns.eventId))
        .where(isNull(events.archivedAt)),
      ctx.db
        .select({ total: count() })
        .from(eventCheckIns)
        .innerJoin(events, eq(events.id, eventCheckIns.eventId))
        .where(
          and(isNull(events.archivedAt), gte(eventCheckIns.checkedInAt, since)),
        ),
      ctx.db
        .select({ total: count() })
        .from(events)
        .where(isNull(events.archivedAt)),
      ctx.db
        .select({ total: count() })
        .from(events)
        .where(and(isNull(events.archivedAt), lt(events.startsAt, now))),
      ctx.db
        .select({ total: count() })
        .from(events)
        .where(and(isNull(events.archivedAt), gte(events.startsAt, now))),
      // `count(eventCheckIns.id)`, never `count(*)`: the LEFT JOIN gives an
      // event nobody attended one row, and `count(*)` would score it as one
      // attendee.
      ctx.db
        .select({
          events: countDistinct(events.id),
          checkIns: count(eventCheckIns.id),
        })
        .from(events)
        .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
        .where(and(isNull(events.archivedAt), lt(events.startsAt, now))),
      ctx.db
        .select({
          id: events.id,
          title: events.title,
          startsAt: events.startsAt,
          location: events.location,
          checkInEnabled: events.checkInEnabled,
          currentCheckIns: count(eventCheckIns.id),
          maxCheckIns: events.maxCheckIns,
        })
        .from(events)
        .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
        .where(and(isNull(events.archivedAt), gte(events.startsAt, now)))
        .groupBy(events.id)
        .orderBy(asc(events.startsAt))
        .limit(1),
    ]);

    const pastCount = asInt(pastAttendance?.events);
    const averageAttendance =
      pastCount === 0
        ? 0
        : Math.round((asInt(pastAttendance?.checkIns) / pastCount) * 10) / 10;

    const nextEvent = next[0]
      ? {
          ...next[0],
          currentCheckIns: asInt(next[0].currentCheckIns),
        }
      : null;

    return {
      members: {
        total: asInt(memberTotals?.total),
        withCheckIns: asInt(checkInTotals?.withCheckIns),
      },
      checkIns: {
        total: asInt(checkInTotals?.total),
        last30Days: asInt(checkInsLast30?.total),
      },
      events: {
        total: asInt(liveEvents?.total),
        past: asInt(pastEvents?.total),
        upcoming: asInt(upcomingEvents?.total),
        averageAttendance,
      },
      nextEvent,
    };
  }),
});
