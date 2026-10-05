import { TRPCError } from "@trpc/server";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  COMMITTEE_STATUSES,
  committeeAnswerFields,
  committeeApplySchema,
  committeeIdsSchema,
  closedCommitteePicks,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
} from "../committee-cycle";
import { notFound } from "../errors";
import { isUndefinedTable, isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  COMMITTEE_APPLY_LIMIT,
  EXPORT_COMMITTEE_LIMIT,
} from "../rate-limit";
import { semester, semesterLabel, semesterPattern } from "../terms";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
  committeeApplications,
  committeeCycles,
  users,
  type db,
} from "@buzz/db";

const statusSchema = z.enum(COMMITTEE_STATUSES);

const cycleInput = z
  .object({ cycle: z.string().regex(semesterPattern).optional() })
  .nullish();

type Db = typeof db;

async function findCycle(database: Db, id: string) {
  try {
    const [row] = await database
      .select()
      .from(committeeCycles)
      .where(eq(committeeCycles.id, id));
    return row ?? null;
  } catch (error) {
    if (isUndefinedTable(error)) return null;
    throw error;
  }
}

/**
 * The cycle an officer screen shows when none is picked: this semester's if
 * it exists, else the one that closed most recently.
 */
async function defaultCycleId(database: Db, now: Date) {
  const current = semester(now);
  if (await findCycle(database, current)) return current;
  const [latest] = await database
    .select({ id: committeeCycles.id })
    .from(committeeCycles)
    .orderBy(desc(committeeCycles.closesAt))
    .limit(1);
  return latest?.id ?? current;
}

async function openCurrentCycle(database: Db, now: Date) {
  const cycle = await findCycle(database, semester(now));
  if (!cycle || !isCommitteeCycleOpen(cycle.closesAt, now)) cycleClosed();
  return cycle;
}

function cycleClosed(): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Committee applications are closed.",
  });
}

function answersLocked(): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message:
      "This application is already in review. Ask an officer if something should change.",
  });
}

const applicationSelect = {
  id: committeeApplications.id,
  userId: committeeApplications.userId,
  cycle: committeeApplications.cycle,
  wantsEvents: committeeApplications.wantsEvents,
  wantsMarketing: committeeApplications.wantsMarketing,
  wantsTreasury: committeeApplications.wantsTreasury,
  wantsWebsite: committeeApplications.wantsWebsite,
  discordHandle: committeeApplications.discordHandle,
  eventsWhy: committeeApplications.eventsWhy,
  eventsCollabs: committeeApplications.eventsCollabs,
  marketingWhy: committeeApplications.marketingWhy,
  marketingConnections: committeeApplications.marketingConnections,
  treasuryWhy: committeeApplications.treasuryWhy,
  websiteWhy: committeeApplications.websiteWhy,
  websiteLinks: committeeApplications.websiteLinks,
  otherOrgs: committeeApplications.otherOrgs,
  comments: committeeApplications.comments,
  status: committeeApplications.status,
  submittedAt: committeeApplications.submittedAt,
  createdAt: committeeApplications.createdAt,
  updatedAt: committeeApplications.updatedAt,
} as const;

export const committeeRouter = createTRPCRouter({
  mine: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const cycleId = semester(now);
    const cycle = await findCycle(ctx.db, cycleId);
    let row;
    try {
      row = await ctx.db.query.committeeApplications.findFirst({
        where: and(
          eq(committeeApplications.userId, ctx.session.user.id),
          eq(committeeApplications.cycle, cycleId),
        ),
      });
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
      row = undefined;
    }

    const application = row
      ? (({ officerNotes: _notes, ...safe }) => safe)(row)
      : null;

    return {
      application,
      cycle: cycle ? cycle.id : null,
      label: semesterLabel(cycleId),
      closesAt: cycle ? cycle.closesAt : null,
      committees: cycle ? cycle.committees : [],
      open: cycle ? isCommitteeCycleOpen(cycle.closesAt, now) : false,
    };
  }),

  submit: protectedProcedure
    .input(committeeApplySchema)
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `committee-apply:${ctx.session.user.id}`,
        COMMITTEE_APPLY_LIMIT,
      );

      const cycle = await openCurrentCycle(ctx.db, new Date());

      const existing = await ctx.db.query.committeeApplications.findFirst({
        where: and(
          eq(committeeApplications.userId, ctx.session.user.id),
          eq(committeeApplications.cycle, cycle.id),
        ),
        columns: {
          id: true,
          status: true,
          wantsEvents: true,
          wantsMarketing: true,
          wantsTreasury: true,
          wantsWebsite: true,
        },
      });

      if (existing && isCommitteeApplicationLocked(existing.status)) {
        answersLocked();
      }

      if (closedCommitteePicks(input, cycle.committees, existing).length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That committee is not taking applications right now.",
        });
      }

      const answers = committeeAnswerFields(input);

      if (!existing) {
        try {
          const [created] = await ctx.db
            .insert(committeeApplications)
            .values({
              userId: ctx.session.user.id,
              cycle: cycle.id,
              status: "submitted",
              ...answers,
            })
            .returning(applicationSelect);
          return created;
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "You already applied this cycle.",
            });
          }
          throw error;
        }
      }

      const [updated] = await ctx.db
        .update(committeeApplications)
        .set({
          ...answers,
          status: "submitted",
        })
        .where(eq(committeeApplications.id, existing.id))
        .returning(applicationSelect);
      return updated;
    }),

  withdraw: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `committee-apply:${ctx.session.user.id}`,
      COMMITTEE_APPLY_LIMIT,
    );

    const existing = await ctx.db.query.committeeApplications.findFirst({
      where: and(
        eq(committeeApplications.userId, ctx.session.user.id),
        eq(committeeApplications.cycle, semester(new Date())),
      ),
      columns: { id: true, status: true },
    });

    if (!existing) {
      notFound("Application");
    }
    if (isCommitteeApplicationLocked(existing.status)) {
      answersLocked();
    }

    const [updated] = await ctx.db
      .update(committeeApplications)
      .set({ status: "withdrawn" })
      .where(eq(committeeApplications.id, existing.id))
      .returning(applicationSelect);
    return updated;
  }),

  list: adminProcedure.input(cycleInput).query(async ({ ctx, input }) => {
    try {
      const cycleId =
        input?.cycle ?? (await defaultCycleId(ctx.db, new Date()));
      return await ctx.db
        .select({
          ...applicationSelect,
          officerNotes: committeeApplications.officerNotes,
          name: users.name,
          email: users.email,
        })
        .from(committeeApplications)
        .innerJoin(users, eq(users.id, committeeApplications.userId))
        .where(eq(committeeApplications.cycle, cycleId))
        .orderBy(desc(committeeApplications.submittedAt));
    } catch (error) {
      if (isUndefinedTable(error)) return [];
      throw error;
    }
  }),

  byId: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select({
          ...applicationSelect,
          officerNotes: committeeApplications.officerNotes,
          name: users.name,
          email: users.email,
        })
        .from(committeeApplications)
        .innerJoin(users, eq(users.id, committeeApplications.userId))
        .where(eq(committeeApplications.id, input.id));

      if (!row) {
        notFound("Application");
      }
      return row;
    }),

  setStatus: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        status: statusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ id: committeeApplications.id })
        .from(committeeApplications)
        .where(eq(committeeApplications.id, input.id));

      if (!existing) {
        notFound("Application");
      }

      const [updated] = await ctx.db
        .update(committeeApplications)
        .set({ status: input.status })
        .where(eq(committeeApplications.id, input.id))
        .returning(applicationSelect);
      return updated;
    }),

  setNotes: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        officerNotes: z
          .string()
          .trim()
          .max(4000)
          .optional()
          .transform((value) => (value && value.length > 0 ? value : null)),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ id: committeeApplications.id })
        .from(committeeApplications)
        .where(eq(committeeApplications.id, input.id));

      if (!existing) {
        notFound("Application");
      }

      const [updated] = await ctx.db
        .update(committeeApplications)
        .set({ officerNotes: input.officerNotes ?? null })
        .where(eq(committeeApplications.id, input.id))
        .returning({
          ...applicationSelect,
          officerNotes: committeeApplications.officerNotes,
        });
      return updated;
    }),

  exportCycle: adminProcedure
    .input(cycleInput)
    .query(async ({ ctx, input }) => {
      assertRateLimit(
        `export-committee:${ctx.session.user.id}`,
        EXPORT_COMMITTEE_LIMIT,
      );
      const cycleId =
        input?.cycle ?? (await defaultCycleId(ctx.db, new Date()));

      const rows = await ctx.db
        .select({
          name: users.name,
          email: users.email,
          discordHandle: committeeApplications.discordHandle,
          wantsEvents: committeeApplications.wantsEvents,
          wantsMarketing: committeeApplications.wantsMarketing,
          wantsTreasury: committeeApplications.wantsTreasury,
          wantsWebsite: committeeApplications.wantsWebsite,
          eventsWhy: committeeApplications.eventsWhy,
          eventsCollabs: committeeApplications.eventsCollabs,
          marketingWhy: committeeApplications.marketingWhy,
          marketingConnections: committeeApplications.marketingConnections,
          treasuryWhy: committeeApplications.treasuryWhy,
          websiteWhy: committeeApplications.websiteWhy,
          websiteLinks: committeeApplications.websiteLinks,
          otherOrgs: committeeApplications.otherOrgs,
          comments: committeeApplications.comments,
          status: committeeApplications.status,
          officerNotes: committeeApplications.officerNotes,
          submittedAt: committeeApplications.submittedAt,
        })
        .from(committeeApplications)
        .innerJoin(users, eq(users.id, committeeApplications.userId))
        .where(eq(committeeApplications.cycle, cycleId))
        .orderBy(desc(committeeApplications.submittedAt))
        .limit(5000);

      return { cycle: cycleId, rows, truncated: rows.length >= 5000 };
    }),

  /** Every recruiting window, newest first, with how many applied. */
  cycles: adminProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const [cycles, counts] = await Promise.all([
      ctx.db
        .select()
        .from(committeeCycles)
        .orderBy(desc(committeeCycles.closesAt)),
      ctx.db
        .select({ cycle: committeeApplications.cycle, n: count() })
        .from(committeeApplications)
        .groupBy(committeeApplications.cycle),
    ]);
    return {
      current: semester(now),
      currentLabel: semesterLabel(semester(now)),
      cycles: cycles.map((cycle) => ({
        id: cycle.id,
        label: semesterLabel(cycle.id),
        closesAt: cycle.closesAt,
        committees: cycle.committees,
        open: isCommitteeCycleOpen(cycle.closesAt, now),
        applications: counts.find((row) => row.cycle === cycle.id)?.n ?? 0,
      })),
    };
  }),

  /** Opens this semester's applications. One cycle per semester. */
  openCycle: adminProcedure
    .input(
      z.object({
        closesAt: z.date(),
        committees: committeeIdsSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      if (input.closesAt.getTime() <= now.getTime()) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Pick a close date in the future.",
        });
      }
      const id = semester(now);
      try {
        const [created] = await ctx.db
          .insert(committeeCycles)
          .values({
            id,
            closesAt: input.closesAt,
            ...(input.committees && { committees: input.committees }),
            createdById: ctx.session.user.id,
          })
          .returning();
        return created;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${semesterLabel(id)} applications already exist. Change the close date instead.`,
          });
        }
        throw error;
      }
    }),

  /** Moves the close date. A date in the past closes applications now. */
  setCycleCloses: adminProcedure
    .input(
      z.object({
        id: z.string().regex(semesterPattern),
        closesAt: z.date(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(committeeCycles)
        .set({ closesAt: input.closesAt })
        .where(eq(committeeCycles.id, input.id))
        .returning();
      if (!updated) notFound("Committee cycle");
      return updated;
    }),

  /** Which committees this cycle takes applications for. */
  setCycleCommittees: adminProcedure
    .input(
      z.object({
        id: z.string().regex(semesterPattern),
        committees: committeeIdsSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(committeeCycles)
        .set({ committees: input.committees })
        .where(eq(committeeCycles.id, input.id))
        .returning();
      if (!updated) notFound("Committee cycle");
      return updated;
    }),
});
