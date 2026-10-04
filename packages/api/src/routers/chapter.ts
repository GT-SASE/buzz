import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { asInt } from "../aggregates";
import { periodSince } from "../periods";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { eventCheckIns, eventRsvps, events, users } from "@buzz/db";

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

  /**
   * Past events in a window, newest first. Campus listings (0 points,
   * check-in never opened, nobody came) stay out. Archived events stay in:
   * hiding one from the calendar must not erase the year.
   */
  attendance: adminProcedure
    .input(
      z.object({
        period: z.enum(["30d", "90d", "semester", "all"]).default("semester"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const since = periodSince(input.period, now);
      const inWindow = since
        ? and(lt(events.startsAt, now), gte(events.startsAt, since))
        : lt(events.startsAt, now);
      const countable = or(
        eq(events.checkInEnabled, true),
        gt(events.pointsValue, 0),
        gt(events.currentCheckIns, 0),
      );
      const where = and(inWindow, countable);

      const [[totals], recent] = await Promise.all([
        ctx.db
          .select({
            events: countDistinct(events.id),
            checkIns: count(eventCheckIns.id),
            uniqueMembers: countDistinct(eventCheckIns.userId),
          })
          .from(events)
          .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
          .where(where),
        ctx.db
          .select({
            id: events.id,
            title: events.title,
            startsAt: events.startsAt,
            checkIns: count(eventCheckIns.id),
          })
          .from(events)
          .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
          .where(where)
          .groupBy(events.id)
          .orderBy(desc(events.startsAt))
          .limit(SERIES_LIMIT),
      ]);

      const eventCount = asInt(totals?.events);
      const checkInCount = asInt(totals?.checkIns);
      const averageAttendance =
        eventCount === 0
          ? 0
          : Math.round((checkInCount / eventCount) * 10) / 10;

      return {
        period: input.period,
        since,
        until: now,
        events: eventCount,
        checkIns: checkInCount,
        uniqueMembers: asInt(totals?.uniqueMembers),
        averageAttendance,
        series: recent.map((row) => ({
          id: row.id,
          title: row.title,
          startsAt: row.startsAt,
          checkIns: asInt(row.checkIns),
        })),
      };
    }),

  /**
   * Chart data for the officer events page. Per past event: check-ins split
   * into first-timers (no earlier check-in anywhere) and returning members.
   * Plus RSVP counts for what is coming up.
   */
  turnout: adminProcedure
    .input(
      z.object({
        period: z.enum(["30d", "90d", "semester", "all"]).default("semester"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const since = periodSince(input.period, now);
      const inWindow = since
        ? and(lt(events.startsAt, now), gte(events.startsAt, since))
        : lt(events.startsAt, now);
      const countable = or(
        eq(events.checkInEnabled, true),
        gt(events.pointsValue, 0),
        gt(events.currentCheckIns, 0),
      );
      // Earlier check-ins by the same member, from the same table.
      const prior = sql.identifier("prior_check_in");

      const [past, upcoming] = await Promise.all([
        ctx.db
          .select({
            id: events.id,
            title: events.title,
            startsAt: events.startsAt,
            checkIns: count(eventCheckIns.id),
            firstTimers: sql<number>`count(${eventCheckIns.id}) filter (where not exists (
              select 1 from ${eventCheckIns} as ${prior}
              where ${prior}.${sql.identifier(eventCheckIns.userId.name)} = ${eventCheckIns.userId}
                and ${prior}.${sql.identifier(eventCheckIns.checkedInAt.name)} < ${eventCheckIns.checkedInAt}
            ))`,
          })
          .from(events)
          .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
          .where(and(inWindow, countable))
          .groupBy(events.id)
          .orderBy(desc(events.startsAt))
          .limit(SERIES_LIMIT),
        ctx.db
          .select({
            id: events.id,
            title: events.title,
            startsAt: events.startsAt,
            rsvps: count(eventRsvps.userId),
          })
          .from(events)
          .leftJoin(eventRsvps, eq(eventRsvps.eventId, events.id))
          .where(and(isNull(events.archivedAt), gte(events.startsAt, now)))
          .groupBy(events.id)
          .orderBy(asc(events.startsAt))
          .limit(UPCOMING_LIMIT),
      ]);

      return {
        // Oldest first: the chart reads left to right in time.
        events: past.reverse().map((row) => {
          const checkIns = asInt(row.checkIns);
          const firstTimers = asInt(row.firstTimers);
          return {
            id: row.id,
            title: row.title,
            startsAt: row.startsAt,
            checkIns,
            firstTimers,
            returning: checkIns - firstTimers,
          };
        }),
        upcoming: upcoming.map((row) => ({
          id: row.id,
          title: row.title,
          startsAt: row.startsAt,
          rsvps: asInt(row.rsvps),
        })),
      };
    }),
});

const SERIES_LIMIT = 48;
const UPCOMING_LIMIT = 12;
