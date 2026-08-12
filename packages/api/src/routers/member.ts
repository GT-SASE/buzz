import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNull,
  max,
  or,
  sum,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  asDate,
  asInt,
  checkInCount,
  memberSince,
  pointsSum,
} from "../aggregates";
import { notFound } from "../errors";
import { EXPORT_ROSTER_LIMIT, takeToken } from "../rate-limit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import type * as BuzzDbModule from "@buzz/db";
import { eventCheckIns, events, sessions, users } from "@buzz/db";

type BuzzDb = typeof BuzzDbModule.db;

/**
 * A search for "100%" or "a_b" is looking for those characters, not for a
 * pattern. Done in one pass so the backslashes this adds are never re-escaped,
 * and backslash is already LIKE's default escape character in Postgres, so no
 * ESCAPE clause is needed to make it hold.
 */
export function escapeLikePattern(input: string) {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Shared by the on-screen roster and the export, so one search means one result set. */
function rosterFilter(search: string | undefined) {
  if (!search) return undefined;
  const pattern = `%${escapeLikePattern(search)}%`;
  return or(ilike(users.name, pattern), ilike(users.email, pattern));
}

const rosterSort = z.enum(["points", "name", "recent"]);

/**
 * Live (non-archived) check-ins as a Drizzle subquery. Roster aggregates join
 * this rather than CASE expressions over a LEFT JOIN to events.
 */
function liveCheckInsSubquery(db: BuzzDb) {
  return db
    .select({
      userId: eventCheckIns.userId,
      pointsEarned: eventCheckIns.pointsEarned,
      checkedInAt: eventCheckIns.checkedInAt,
    })
    .from(eventCheckIns)
    .innerJoin(
      events,
      and(eq(events.id, eventCheckIns.eventId), isNull(events.archivedAt)),
    )
    .as("live_check_ins");
}

export const memberRouter = createTRPCRouter({
  // ---------------------------------------------------------------- officers

  /** The roster. Everyone who has signed in appears, attendance or not. */
  list: adminProcedure
    .input(
      z.object({
        search: z.string().trim().max(100).optional(),
        sort: rosterSort.default("points"),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const filter = rosterFilter(input.search);
      const live = liveCheckInsSubquery(ctx.db);
      const totalPoints = sum(live.pointsEarned);
      const totalEvents = count(live.userId);
      const lastCheckIn = max(live.checkedInAt);

      // `(col IS NULL) ASC` puts non-nulls first — nulls last without SQL text.
      const orderBy: SQL[] = (() => {
        switch (input.sort) {
          case "name":
            return [asc(isNull(users.name)), asc(users.name), asc(users.email)];
          case "recent":
            return [
              asc(isNull(lastCheckIn)),
              desc(lastCheckIn),
              asc(users.email),
            ];
          default:
            return [desc(totalPoints), asc(users.email)];
        }
      })();

      const [rows, [totals]] = await Promise.all([
        ctx.db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            role: users.role,
            totalPoints,
            totalEvents,
            lastCheckInAt: lastCheckIn,
          })
          .from(users)
          .leftJoin(live, eq(live.userId, users.id))
          .where(filter)
          .groupBy(users.id)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(input.offset),
        ctx.db.select({ total: count() }).from(users).where(filter),
      ]);

      return {
        members: rows.map((row) => ({
          ...row,
          totalPoints: asInt(row.totalPoints),
          totalEvents: asInt(row.totalEvents),
          lastCheckInAt: asDate(row.lastCheckInAt),
        })),
        total: asInt(totals?.total),
      };
    }),

  /**
   * The whole roster for one search, not the page of it currently on screen —
   * an export of 25 of 400 members is a trap, not a file. No id: nothing
   * downstream needs one and a spreadsheet of internal ids is a liability.
   */
  exportRoster: adminProcedure
    .input(z.object({ search: z.string().trim().max(100).optional() }))
    .query(async ({ ctx, input }) => {
      if (
        !takeToken(`export-roster:${ctx.session.user.id}`, EXPORT_ROSTER_LIMIT)
      ) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "Too many requests. Try again shortly.",
        });
      }

      const live = liveCheckInsSubquery(ctx.db);
      const totalPoints = sum(live.pointsEarned);
      const totalEvents = count(live.userId);
      const lastCheckIn = max(live.checkedInAt);

      const rows = await ctx.db
        .select({
          name: users.name,
          email: users.email,
          role: users.role,
          totalPoints,
          totalEvents,
          lastCheckInAt: lastCheckIn,
        })
        .from(users)
        .leftJoin(live, eq(live.userId, users.id))
        .where(rosterFilter(input.search))
        .groupBy(users.id)
        .orderBy(desc(totalPoints), asc(users.email))
        .limit(5000);

      return {
        members: rows.map((row) => ({
          ...row,
          totalPoints: asInt(row.totalPoints),
          totalEvents: asInt(row.totalEvents),
          lastCheckInAt: asDate(row.lastCheckInAt),
        })),
        truncated: rows.length >= 5000,
      };
    }),

  /** One member's card: identity, totals, and everything they turned up to. */
  byId: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const member = await ctx.db.query.users.findFirst({
        where: eq(users.id, input.id),
        columns: {
          id: true,
          name: true,
          email: true,
          role: true,
          image: true,
        },
      });

      if (!member) {
        notFound("Member");
      }

      const [[totals], history] = await Promise.all([
        ctx.db
          .select({
            totalEvents: checkInCount,
            totalPoints: pointsSum,
            memberSince,
          })
          .from(eventCheckIns)
          .innerJoin(events, eq(events.id, eventCheckIns.eventId))
          .where(
            and(eq(eventCheckIns.userId, member.id), isNull(events.archivedAt)),
          ),
        ctx.db
          .select({
            eventId: events.id,
            title: events.title,
            startsAt: events.startsAt,
            location: events.location,
            pointsEarned: eventCheckIns.pointsEarned,
            method: eventCheckIns.method,
            checkedInAt: eventCheckIns.checkedInAt,
          })
          .from(eventCheckIns)
          .innerJoin(events, eq(events.id, eventCheckIns.eventId))
          .where(
            and(eq(eventCheckIns.userId, member.id), isNull(events.archivedAt)),
          )
          .orderBy(desc(eventCheckIns.checkedInAt))
          .limit(200),
      ]);

      return {
        member,
        totalPoints: asInt(totals?.totalPoints),
        totalEvents: asInt(totals?.totalEvents),
        memberSince: asDate(totals?.memberSince),
        history,
      };
    }),

  /** Drop every session for a compromised or departing officer account. */
  revokeSessions: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(sessions).where(eq(sessions.userId, input.userId));
      return { success: true };
    }),

  // ----------------------------------------------------------------- members

  /**
   * Ranked by points over every member with live attendance. Ordering is done
   * in Postgres; competition ranks (ties share a place) are applied here so we
   * do not need window-function SQL.
   */
  leaderboard: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const totalPoints = sum(eventCheckIns.pointsEarned);
      const totalEvents = count(eventCheckIns.id);

      const rows = await ctx.db
        .select({
          userId: users.id,
          name: users.name,
          totalPoints,
          totalEvents,
        })
        .from(users)
        .innerJoin(eventCheckIns, eq(eventCheckIns.userId, users.id))
        .innerJoin(
          events,
          and(eq(events.id, eventCheckIns.eventId), isNull(events.archivedAt)),
        )
        .groupBy(users.id)
        .orderBy(desc(totalPoints), asc(users.name), asc(users.id));

      let rank = 0;
      let lastPoints: number | null = null;
      const ranked = rows.map((row, index) => {
        const points = asInt(row.totalPoints);
        if (lastPoints === null || points !== lastPoints) {
          rank = index + 1;
          lastPoints = points;
        }
        return {
          userId: row.userId,
          rank,
          name: row.name ?? "Member",
          totalPoints: points,
          totalEvents: asInt(row.totalEvents),
          isYou: row.userId === userId,
        };
      });

      const top = ranked
        .slice(0, input.limit)
        .map(({ userId: _id, ...rest }) => rest);
      const youRow = ranked.find((row) => row.isYou);

      return {
        top,
        you: youRow
          ? {
              rank: youRow.rank,
              totalPoints: youRow.totalPoints,
              totalEvents: youRow.totalEvents,
            }
          : null,
      };
    }),
});
