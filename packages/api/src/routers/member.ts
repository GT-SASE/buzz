import { TRPCError } from "@trpc/server";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lte,
  max,
  min,
  or,
  sql,
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
import {
  attendanceEvents,
  attendanceFilter,
  attendancePoints,
} from "../attendance";
import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { shapeLeaderboard } from "../leaderboard-rank";
import { isUndefinedTable } from "../pg-errors";
import { leaderboardWindow, schoolYearStart } from "../periods";
import {
  assertRateLimit,
  EXPORT_ROSTER_LIMIT,
  LEADERBOARD_PREF_LIMIT,
  PROFILE_LIMIT,
} from "../rate-limit";
import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
  superAdminProcedure,
} from "../trpc";
import type * as BuzzDbModule from "@buzz/db";
import {
  eventCheckIns,
  events,
  leaderboardPreferences,
  memberProfiles,
  pointsLedger,
  resumes,
  sessions,
  users,
} from "@buzz/db";

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

/** Empty in the form means unset, which arrives here as null. */
const graduationYearSchema = z.number().int().min(2000).max(2100).nullable();

const rosterSort = z.enum(["points", "name", "recent"]);

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Attendance that still counts. An archived event's check-ins count for
 * nothing — read-time only, so restoring the event brings them back.
 */
function liveCheckInsSubquery(db: BuzzDb) {
  return db
    .select({
      userId: eventCheckIns.userId,
      pointsEarned: eventCheckIns.pointsEarned,
      checkedInAt: eventCheckIns.checkedInAt,
    })
    .from(eventCheckIns)
    .innerJoin(events, eq(events.id, eventCheckIns.eventId))
    .where(isNull(events.archivedAt))
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
            return [
              asc(isNull(totalPoints)),
              desc(totalPoints),
              asc(users.email),
            ];
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
   * Roster-wide figures for the members screen. Tier floors are an input
   * because tiers are a render-time policy in the web app, not a column, and
   * the roster must not hold a second copy of them.
   */
  metrics: adminProcedure
    .input(
      z.object({
        tiers: z.array(z.number().int().min(0)).min(1).max(8).default([0]),
      }),
    )
    .query(async ({ ctx, input }) => {
      // One clock for every window, so "active" and "new" cannot land either
      // side of a tick and disagree.
      const now = new Date();
      const since30 = new Date(now.getTime() - THIRTY_DAYS_MS);
      const yearStart = schoolYearStart(now);

      const live = liveCheckInsSubquery(ctx.db);

      const [[rosterTotals], [officerTotals], attended] = await Promise.all([
        ctx.db.select({ total: count() }).from(users),
        // Super admins hold officer access, so the roster counts them here too.
        ctx.db
          .select({ total: count() })
          .from(users)
          .where(inArray(users.role, ["ADMIN", "SUPER_ADMIN"])),
        // One row per member who has attended anything live. Members with no
        // attendance are the difference against the roster count below.
        ctx.db
          .select({
            points: sum(live.pointsEarned),
            firstCheckInAt: min(live.checkedInAt),
            lastCheckInAt: max(live.checkedInAt),
          })
          .from(users)
          .innerJoin(live, eq(live.userId, users.id))
          .groupBy(users.id),
      ]);

      const floors = [...input.tiers].sort((a, b) => a - b);
      const bands = floors.map(() => 0);

      let totalPoints = 0;
      let activeLast30 = 0;
      let activeThisYear = 0;
      let newLast30 = 0;

      for (const row of attended) {
        const points = asInt(row.points);
        totalPoints += points;

        const last = asDate(row.lastCheckInAt);
        if (last && last >= since30) activeLast30 += 1;
        if (last && last >= yearStart) activeThisYear += 1;

        const first = asDate(row.firstCheckInAt);
        if (first && first >= since30) newLast30 += 1;

        // Highest floor the total clears; a total under the lowest floor sits
        // in the bottom band rather than nowhere.
        let band = 0;
        for (let i = 0; i < floors.length; i += 1) {
          if (points >= floors[i]!) band = i;
        }
        bands[band] = (bands[band] ?? 0) + 1;
      }

      const total = asInt(rosterTotals?.total);
      const withCheckIns = attended.length;
      // Everyone who has never checked in has zero points, so they all sit in
      // the bottom band without a row of their own.
      bands[0] = (bands[0] ?? 0) + Math.max(0, total - withCheckIns);

      return {
        total,
        officers: asInt(officerTotals?.total),
        withCheckIns,
        neverCheckedIn: Math.max(0, total - withCheckIns),
        activeLast30,
        activeThisYear,
        newLast30,
        totalPoints,
        averagePoints:
          total === 0 ? 0 : Math.round((totalPoints / total) * 10) / 10,
        tiers: floors.map((floor, index) => ({
          min: floor,
          members: bands[index] ?? 0,
        })),
        since: { last30: since30, schoolYear: yearStart },
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
      await assertRateLimit(
        ctx.db,
        `export-roster:${ctx.session.user.id}`,
        EXPORT_ROSTER_LIMIT,
      );

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
        .orderBy(asc(isNull(totalPoints)), desc(totalPoints), asc(users.email))
        .limit(5000);

      // After the read, before the data leaves: an export that cannot be
      // logged is not handed over.
      await recordAudit(ctx.db, {
        actorId: ctx.session.user.id,
        action: "export.roster",
        targetType: "roster",
        after: {
          rows: rows.length,
          truncated: rows.length >= 5000,
          search: input.search ?? null,
        },
      });

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

      const [[totals], history, resume] = await Promise.all([
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
        ctx.db.query.resumes
          .findFirst({
            where: eq(resumes.userId, member.id),
            columns: {
              fileName: true,
              byteSize: true,
              uploadedAt: true,
            },
          })
          .catch((error) => {
            if (isUndefinedTable(error)) return null;
            throw error;
          }),
      ]);

      return {
        member,
        totalPoints: asInt(totals?.totalPoints),
        totalEvents: asInt(totals?.totalEvents),
        memberSince: asDate(totals?.memberSince),
        resume: resume ?? null,
        history,
      };
    }),

  /**
   * Drop every session for a compromised or departing account.
   *
   * An officer can do this for members and other officers. A super admin's
   * sessions are off limits to them — that is an edit of a super admin, and
   * only a super admin may do it.
   */
  revokeSessions: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const target = await ctx.db.query.users.findFirst({
        where: eq(users.id, input.userId),
        columns: { role: true },
      });

      if (
        target?.role === "SUPER_ADMIN" &&
        ctx.session.user.role !== "SUPER_ADMIN"
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only a super admin can edit a super admin.",
        });
      }

      const revoked = await ctx.db
        .delete(sessions)
        .where(eq(sessions.userId, input.userId))
        .returning({ sessionToken: sessions.sessionToken });

      return { success: true, revoked: revoked.length };
    }),

  /**
   * Promote or demote. The only writer of `buzz_user.role` in the app.
   *
   * `superAdminProcedure` refuses an officer before this runs, so an ADMIN
   * cannot change anyone's role and cannot demote a SUPER_ADMIN. The value
   * written is the one the caller asked for — never a hardcoded promotion.
   */
  setRole: superAdminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: z.enum(["MEMBER", "ADMIN", "SUPER_ADMIN"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The only super admin could otherwise lock everyone out of role
      // changes with one confirm; another super admin has to step you down.
      if (
        input.userId === ctx.session.user.id &&
        input.role !== "SUPER_ADMIN"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Ask another super admin to change your role.",
        });
      }

      return ctx.db.transaction(async (tx) => {
        // Locked so the logged "before" is the role this change replaces, not
        // one a concurrent change has already moved.
        const [before] = await tx
          .select({ role: users.role, email: users.email })
          .from(users)
          .where(eq(users.id, input.userId))
          .for("update");

        if (!before) {
          notFound("Member");
        }

        const [updated] = await tx
          .update(users)
          .set({ role: input.role })
          .where(eq(users.id, input.userId))
          .returning({ id: users.id, role: users.role });

        if (!updated) {
          notFound("Member");
        }

        // Saving the role someone already has changes nothing, so it leaves
        // nothing in the log either.
        if (before.role !== updated.role) {
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "member.set_role",
            targetType: "member",
            targetId: input.userId,
            targetLabel: before.email,
            before: { role: before.role },
            after: { role: updated.role },
          });
        }

        return { success: true, role: updated.role };
      });
    }),

  // ----------------------------------------------------------------- members

  /**
   * Attendance standings for one period, ranked in SQL from the points
   * ledger: the check-in rows net of removals, on events that are not
   * archived (archived events count for nothing, and count again once
   * restored). Equal points break on who checked in first, then on id.
   *
   * A check-in belongs to the period its event started in, not the moment it
   * was recorded or taken back: a removal logged next semester still nets
   * against the grant in the semester it was earned.
   *
   * The ledger holds one row per check-in plus one per removal, so a member's
   * event count is the grants minus the removals, and a member whose every
   * check-in was removed is off the board.
   *
   * Only `limit` rows, plus the viewer's own when they rank lower, leave the
   * database. A member who hid their name stays at their true rank with no
   * name in the payload.
   */
  leaderboard: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(50).default(10),
        period: z.enum(["semester", "year", "all"]).default("all"),
      }),
    )
    .query(async ({ ctx, input }) => {
      const viewerId = ctx.session.user.id;
      const window = leaderboardWindow(input.period, new Date());

      const board = (withPreferences: boolean) => {
        const totalPoints = attendancePoints;
        const totalEvents = attendanceEvents;
        const firstAt = sql<Date>`min(${pointsLedger.at})`;

        const totals = ctx.db
          .select({
            userId: pointsLedger.userId,
            totalPoints: totalPoints.as("total_points"),
            totalEvents: totalEvents.as("total_events"),
            firstAt: firstAt.as("first_at"),
          })
          .from(pointsLedger)
          .innerJoin(events, eq(events.id, pointsLedger.eventId))
          .where(attendanceFilter(window))
          .groupBy(pointsLedger.userId)
          .having(sql`${totalEvents} > 0`)
          .as("totals");

        const ranked = ctx.db
          .select({
            userId: totals.userId,
            totalPoints: totals.totalPoints,
            totalEvents: totals.totalEvents,
            rank: sql<number>`rank() over (order by ${totals.totalPoints} desc)`.as(
              "rank",
            ),
            position:
              sql<number>`row_number() over (order by ${totals.totalPoints} desc, ${totals.firstAt} asc, ${totals.userId} asc)`.as(
                "position",
              ),
          })
          .from(totals)
          .as("ranked");

        const hidden = withPreferences
          ? sql<boolean>`coalesce(${leaderboardPreferences.hideName}, false)`
          : sql<boolean>`false`;

        const query = ctx.db
          .select({
            userId: ranked.userId,
            rank: ranked.rank,
            position: ranked.position,
            name: users.name,
            hidden: hidden.as("hidden"),
            totalPoints: ranked.totalPoints,
            totalEvents: ranked.totalEvents,
          })
          .from(ranked)
          .innerJoin(users, eq(users.id, ranked.userId));

        return (
          withPreferences
            ? query.leftJoin(
                leaderboardPreferences,
                eq(leaderboardPreferences.userId, ranked.userId),
              )
            : query
        )
          .where(
            or(lte(ranked.position, input.limit), eq(ranked.userId, viewerId)),
          )
          .orderBy(asc(ranked.position))
          .limit(input.limit + 1);
      };

      let rows;
      try {
        rows = await board(true);
      } catch (error) {
        // A preview built before 0016 ran: nobody can have opted out yet.
        if (!isUndefinedTable(error)) throw error;
        rows = await board(false);
      }

      return shapeLeaderboard(
        rows.map((row) => ({
          userId: row.userId,
          rank: asInt(row.rank),
          position: asInt(row.position),
          name: row.name,
          hidden: row.hidden,
          totalPoints: asInt(row.totalPoints),
          totalEvents: asInt(row.totalEvents),
        })),
        viewerId,
        input.limit,
      );
    }),

  /** The caller's own profile. Nothing saved means unset. */
  profile: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [row] = await ctx.db
        .select({ graduationYear: memberProfiles.graduationYear })
        .from(memberProfiles)
        .where(eq(memberProfiles.userId, ctx.session.user.id));
      return { graduationYear: row?.graduationYear ?? null };
    } catch (error) {
      // A preview built before 0016 ran: no one has a profile yet.
      if (isUndefinedTable(error)) return { graduationYear: null };
      throw error;
    }
  }),

  setProfile: protectedProcedure
    .input(z.object({ graduationYear: graduationYearSchema }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `member-profile:${ctx.session.user.id}`,
        PROFILE_LIMIT,
      );
      const values = {
        graduationYear: input.graduationYear,
        updatedAt: new Date(),
      };
      await ctx.db
        .insert(memberProfiles)
        .values({ userId: ctx.session.user.id, ...values })
        .onConflictDoUpdate({ target: memberProfiles.userId, set: values });
      return { graduationYear: input.graduationYear };
    }),

  /** For the roster: graduation years of the members on the page. */
  graduationYears: adminProcedure
    .input(z.object({ userIds: z.array(z.string().min(1)).max(100) }))
    .query(async ({ ctx, input }) => {
      if (input.userIds.length === 0) return {};
      try {
        const rows = await ctx.db
          .select({
            userId: memberProfiles.userId,
            graduationYear: memberProfiles.graduationYear,
          })
          .from(memberProfiles)
          .where(inArray(memberProfiles.userId, input.userIds));
        const years: Record<string, number> = {};
        for (const row of rows) {
          if (row.graduationYear !== null)
            years[row.userId] = row.graduationYear;
        }
        return years;
      } catch (error) {
        if (isUndefinedTable(error)) return {};
        throw error;
      }
    }),

  /** An officer's correction. Logged like every other officer edit. */
  setGraduationYear: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        graduationYear: graduationYearSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [member] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.userId));
        if (!member) notFound("Member");

        // Locked so the logged "before" is the year this edit replaces.
        const [before] = await tx
          .select({ graduationYear: memberProfiles.graduationYear })
          .from(memberProfiles)
          .where(eq(memberProfiles.userId, input.userId))
          .for("update");
        const was = before?.graduationYear ?? null;

        const values = {
          graduationYear: input.graduationYear,
          updatedAt: new Date(),
        };
        await tx
          .insert(memberProfiles)
          .values({ userId: input.userId, ...values })
          .onConflictDoUpdate({ target: memberProfiles.userId, set: values });

        // The same year again changes nothing, so it logs nothing.
        if (was !== input.graduationYear) {
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "member.set_graduation_year",
            targetType: "member",
            targetId: input.userId,
            targetLabel: member.email,
            before: { graduationYear: was },
            after: { graduationYear: input.graduationYear },
          });
        }
        return { graduationYear: input.graduationYear };
      });
    }),

  /** Whether the caller's name is hidden on the board. Unsaved means shown. */
  leaderboardPreference: protectedProcedure.query(async ({ ctx }) => {
    try {
      const [row] = await ctx.db
        .select({ hideName: leaderboardPreferences.hideName })
        .from(leaderboardPreferences)
        .where(eq(leaderboardPreferences.userId, ctx.session.user.id));
      return { hideName: row?.hideName ?? false };
    } catch (error) {
      if (isUndefinedTable(error)) return { hideName: false };
      throw error;
    }
  }),

  setLeaderboardPreference: protectedProcedure
    .input(z.object({ hideName: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `leaderboard-pref:${ctx.session.user.id}`,
        LEADERBOARD_PREF_LIMIT,
      );
      const values = { hideName: input.hideName, updatedAt: new Date() };
      await ctx.db
        .insert(leaderboardPreferences)
        .values({ userId: ctx.session.user.id, ...values })
        .onConflictDoUpdate({
          target: leaderboardPreferences.userId,
          set: values,
        });
      return { hideName: input.hideName };
    }),
});
