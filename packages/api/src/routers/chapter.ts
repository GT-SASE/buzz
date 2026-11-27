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
  min,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { asInt } from "../aggregates";
import { periodSince, type Period } from "../periods";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { eventCheckIns, eventRsvps, events, users } from "@buzz/db";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Live past events in a window. Campus listings (0 points, check-in never
 * opened, nobody came) stay out.
 */
function countablePastEvents(period: Period, now: Date) {
  const since = periodSince(period, now);
  const inWindow = since
    ? and(lt(events.startsAt, now), gte(events.startsAt, since))
    : lt(events.startsAt, now);
  const anyCheckIn = sql.identifier("any_check_in");
  const countable = or(
    eq(events.checkInEnabled, true),
    gt(events.pointsValue, 0),
    // Uncapped events never bump currentCheckIns, so look at the rows.
    sql`exists (select 1 from ${eventCheckIns} as ${anyCheckIn} where ${anyCheckIn}.${sql.identifier(eventCheckIns.eventId.name)} = ${events.id})`,
  );
  return {
    since,
    where: and(inWindow, countable, isNull(events.archivedAt)),
  };
}

export const chapterRouter = createTRPCRouter({
  /** Chapter-wide numbers for the officer dashboard. Every figure via Drizzle. */
  overview: adminProcedure.query(async ({ ctx }) => {
    // One clock for the whole resolver: read twice, the 30-day window and the
    // past/upcoming split can land either side of a tick and disagree.
    const now = new Date();
    const since = new Date(now.getTime() - THIRTY_DAYS_MS);

    // Three queries, not eight, and the tail is the reason: the pool holds
    // five sockets, so the officer dashboard (this plus attendance, turnout
    // and the event list, all in flight at once) used to queue behind itself.
    // Every figure over live events and their check-ins comes from the one
    // events LEFT JOIN check-ins scan, split with FILTER.
    //
    // `count(eventCheckIns.id)`, never `count(*)`: the LEFT JOIN gives an
    // event nobody attended one row, and `count(*)` would score it as one
    // attendee.
    const pastFilter = sql`${events.startsAt} < ${now}`;
    const upcomingFilter = sql`${events.startsAt} >= ${now}`;
    const [[memberTotals], [liveTotals], next] = await Promise.all([
      ctx.db.select({ total: count() }).from(users),
      ctx.db
        .select({
          events: countDistinct(events.id),
          pastEvents: sql<number>`count(distinct ${events.id}) filter (where ${pastFilter})`,
          upcomingEvents: sql<number>`count(distinct ${events.id}) filter (where ${upcomingFilter})`,
          checkIns: count(eventCheckIns.id),
          withCheckIns: countDistinct(eventCheckIns.userId),
          checkInsLast30: sql<number>`count(${eventCheckIns.id}) filter (where ${eventCheckIns.checkedInAt} >= ${since})`,
          pastCheckIns: sql<number>`count(${eventCheckIns.id}) filter (where ${pastFilter})`,
        })
        .from(events)
        .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
        .where(isNull(events.archivedAt)),
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

    const pastCount = asInt(liveTotals?.pastEvents);
    const averageAttendance =
      pastCount === 0
        ? 0
        : Math.round((asInt(liveTotals?.pastCheckIns) / pastCount) * 10) / 10;

    const nextEvent = next[0]
      ? {
          ...next[0],
          currentCheckIns: asInt(next[0].currentCheckIns),
        }
      : null;

    return {
      members: {
        total: asInt(memberTotals?.total),
        withCheckIns: asInt(liveTotals?.withCheckIns),
      },
      checkIns: {
        total: asInt(liveTotals?.checkIns),
        last30Days: asInt(liveTotals?.checkInsLast30),
      },
      events: {
        total: asInt(liveTotals?.events),
        past: pastCount,
        upcoming: asInt(liveTotals?.upcomingEvents),
        averageAttendance,
      },
      nextEvent,
    };
  }),

  /**
   * Past events in a window, newest first. Campus listings (0 points,
   * check-in never opened, nobody came) and archived events stay out, matching
   * every other figure.
   */
  attendance: adminProcedure
    .input(
      z.object({
        period: z.enum(["30d", "90d", "semester", "all"]).default("semester"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const { since, where } = countablePastEvents(input.period, now);

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
   * into first-timers (no earlier check-in at an event that is not archived) and returning members.
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
      const { where } = countablePastEvents(input.period, now);
      // A check-in is a first-timer's when the member has no live check-in
      // strictly before it, i.e. it is not later than their earliest live one
      // (an archived event counts for nothing, so it cannot make someone
      // "returning"). That earliest time is computed once per member rather
      // than probed per check-in with a correlated NOT EXISTS: at a semester's
      // volume the correlated form re-scanned the event table per row and
      // dominated the officer dashboard's p99.
      const firstLive = ctx.db
        .select({
          userId: eventCheckIns.userId,
          firstAt: min(eventCheckIns.checkedInAt).as("first_at"),
        })
        .from(eventCheckIns)
        .innerJoin(events, eq(events.id, eventCheckIns.eventId))
        .where(isNull(events.archivedAt))
        .groupBy(eventCheckIns.userId)
        .as("first_live");

      const [past, upcoming] = await Promise.all([
        ctx.db
          .select({
            id: events.id,
            title: events.title,
            startsAt: events.startsAt,
            checkIns: count(eventCheckIns.id),
            firstTimers: sql<number>`count(${eventCheckIns.id}) filter (where ${eventCheckIns.checkedInAt} <= ${firstLive.firstAt})`,
          })
          .from(events)
          .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
          .leftJoin(firstLive, eq(firstLive.userId, eventCheckIns.userId))
          .where(where)
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
