import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, gt, notInArray, or } from "drizzle-orm";
import { z } from "zod";

import {
  COMMITTEE_STATUSES,
  committeeAnswerFields,
  committeeApplySchema,
  committeeIdsSchema,
  closedCommitteePicks,
  currentCommitteeCycle,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
  LOCKED_COMMITTEE_STATUSES,
} from "../committee-cycle";
import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { notifyApplicationDecision, noNotice } from "../notify";
import { isUndefinedTable, isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  COMMITTEE_APPLY_LIMIT,
  EXPORT_COMMITTEE_LIMIT,
} from "../rate-limit";
import {
  nextSemester,
  semester,
  semesterLabel,
  semesterPattern,
} from "../terms";
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

/**
 * The cycle members see now (see `currentCommitteeCycle`), found by date
 * window rather than by `semester(now)`. Only cycles still open plus the one
 * named for this semester can win, so that is all the query reads.
 */
async function findCurrentCycle(database: Db, now: Date) {
  try {
    const rows = await database
      .select()
      .from(committeeCycles)
      .where(
        or(
          gt(committeeCycles.closesAt, now),
          eq(committeeCycles.id, semester(now)),
        ),
      );
    return currentCommitteeCycle(rows, now);
  } catch (error) {
    if (isUndefinedTable(error)) return null;
    throw error;
  }
}

/**
 * The cycle an officer screen shows when none is picked: the current one if
 * it exists, else the one that closed most recently.
 */
async function defaultCycleId(database: Db, now: Date) {
  const current = await findCurrentCycle(database, now);
  if (current) return current.id;
  const [latest] = await database
    .select({ id: committeeCycles.id })
    .from(committeeCycles)
    .orderBy(desc(committeeCycles.closesAt))
    .limit(1);
  return latest?.id ?? semester(now);
}

async function openCurrentCycle(database: Db, now: Date) {
  const cycle = await findCurrentCycle(database, now);
  if (!cycle || !isCommitteeCycleOpen(cycle.closesAt, now)) cycleClosed();
  return cycle;
}

/** Semesters an officer may open applications for at `now`. */
function openableSemesters(now: Date) {
  const current = semester(now);
  return [current, nextSemester(current)];
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
    const cycle = await findCurrentCycle(ctx.db, now);
    // The application is keyed by user and cycle id, not by the cycle row.
    const cycleId = cycle?.id ?? semester(now);
    const row = await ctx.db.query.committeeApplications
      .findFirst({
        where: and(
          eq(committeeApplications.userId, ctx.session.user.id),
          eq(committeeApplications.cycle, cycleId),
        ),
      })
      .catch((error: unknown) => {
        if (!isUndefinedTable(error)) throw error;
        return undefined;
      });

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
      await assertRateLimit(
        ctx.db,
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
        // The lock was read earlier; an officer may have decided since.
        .where(
          and(
            eq(committeeApplications.id, existing.id),
            notInArray(committeeApplications.status, [
              ...LOCKED_COMMITTEE_STATUSES,
            ]),
          ),
        )
        .returning(applicationSelect);
      if (!updated) {
        answersLocked();
      }
      return updated;
    }),

  withdraw: protectedProcedure.mutation(async ({ ctx }) => {
    await assertRateLimit(
      ctx.db,
      `committee-apply:${ctx.session.user.id}`,
      COMMITTEE_APPLY_LIMIT,
    );

    const now = new Date();
    const cycle = await findCurrentCycle(ctx.db, now);
    const existing = await ctx.db.query.committeeApplications.findFirst({
      where: and(
        eq(committeeApplications.userId, ctx.session.user.id),
        eq(committeeApplications.cycle, cycle?.id ?? semester(now)),
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
      .where(
        and(
          eq(committeeApplications.id, existing.id),
          notInArray(committeeApplications.status, [
            ...LOCKED_COMMITTEE_STATUSES,
          ]),
        ),
      )
      .returning(applicationSelect);
    if (!updated) {
      answersLocked();
    }
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
      const { updated, applicant } = await ctx.db.transaction(async (tx) => {
        // Locked, so the logged "before" is the status this change replaces.
        const [existing] = await tx
          .select({
            id: committeeApplications.id,
            status: committeeApplications.status,
            cycle: committeeApplications.cycle,
            email: users.email,
            name: users.name,
          })
          .from(committeeApplications)
          .innerJoin(users, eq(users.id, committeeApplications.userId))
          .where(eq(committeeApplications.id, input.id))
          .for("update", { of: committeeApplications });

        if (!existing) {
          notFound("Application");
        }

        const [updated] = await tx
          .update(committeeApplications)
          .set({ status: input.status })
          .where(eq(committeeApplications.id, input.id))
          .returning(applicationSelect);

        if (existing.status !== input.status) {
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "committee.set_status",
            targetType: "application",
            targetId: input.id,
            targetLabel: existing.email,
            before: { status: existing.status, cycle: existing.cycle },
            after: { status: input.status, cycle: existing.cycle },
          });
        }

        return {
          updated,
          // Only a change of status tells the applicant anything.
          applicant:
            existing.status === input.status
              ? null
              : {
                  email: existing.email,
                  name: existing.name,
                  cycle: existing.cycle,
                },
        };
      });

      // After the commit: a failed send never undoes the decision.
      const notice = applicant
        ? await notifyApplicationDecision(
            applicant,
            input.status,
            applicant.cycle,
          )
        : noNotice;
      return { ...updated, notice };
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
      await assertRateLimit(
        ctx.db,
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

      await recordAudit(ctx.db, {
        actorId: ctx.session.user.id,
        action: "export.committee",
        targetType: "cycle",
        targetId: cycleId,
        after: { rows: rows.length, truncated: rows.length >= 5000 },
      });

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
    const current = currentCommitteeCycle(cycles, now)?.id ?? semester(now);
    return {
      current,
      currentLabel: semesterLabel(current),
      // The semesters an officer can still open: this one and the next.
      openable: openableSemesters(now)
        .filter((id) => !cycles.some((cycle) => cycle.id === id))
        .map((id) => ({ id, label: semesterLabel(id) })),
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

  /**
   * Opens applications for a semester, this one or the next, so spring
   * recruiting can open in December. Omitted, the semester is the one the
   * close date falls in. One cycle per semester.
   */
  openCycle: adminProcedure
    .input(
      z.object({
        semester: z.string().regex(semesterPattern).optional(),
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
      const id = input.semester ?? semester(input.closesAt);
      if (!openableSemesters(now).includes(id)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Open applications for this semester or the next one.",
        });
      }
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
