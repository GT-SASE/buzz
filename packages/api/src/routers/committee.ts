import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  COMMITTEE_CYCLE_CLOSES_AT,
  COMMITTEE_CYCLE_ID,
  COMMITTEE_STATUSES,
  committeeAnswerFields,
  committeeApplySchema,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
} from "../committee-cycle";
import { notFound } from "../errors";
import { isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  COMMITTEE_APPLY_LIMIT,
  EXPORT_COMMITTEE_LIMIT,
} from "../rate-limit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { committeeApplications, users } from "@buzz/db";

const statusSchema = z.enum(COMMITTEE_STATUSES);

function cycleClosed() {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "Committee applications are closed.",
  });
}

function answersLocked() {
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
  discordHandle: committeeApplications.discordHandle,
  eventsWhy: committeeApplications.eventsWhy,
  eventsCollabs: committeeApplications.eventsCollabs,
  marketingWhy: committeeApplications.marketingWhy,
  marketingConnections: committeeApplications.marketingConnections,
  treasuryWhy: committeeApplications.treasuryWhy,
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
    const row = await ctx.db.query.committeeApplications.findFirst({
      where: and(
        eq(committeeApplications.userId, ctx.session.user.id),
        eq(committeeApplications.cycle, COMMITTEE_CYCLE_ID),
      ),
    });

    const application = row
      ? (({ officerNotes: _notes, ...safe }) => safe)(row)
      : null;

    return {
      application,
      cycle: COMMITTEE_CYCLE_ID,
      closesAt: COMMITTEE_CYCLE_CLOSES_AT,
      open: isCommitteeCycleOpen(now),
    };
  }),

  submit: protectedProcedure
    .input(committeeApplySchema)
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `committee-apply:${ctx.session.user.id}`,
        COMMITTEE_APPLY_LIMIT,
      );

      if (!isCommitteeCycleOpen(new Date())) {
        cycleClosed();
      }

      const existing = await ctx.db.query.committeeApplications.findFirst({
        where: and(
          eq(committeeApplications.userId, ctx.session.user.id),
          eq(committeeApplications.cycle, COMMITTEE_CYCLE_ID),
        ),
        columns: { id: true, status: true },
      });

      if (existing && isCommitteeApplicationLocked(existing.status)) {
        answersLocked();
      }

      const answers = committeeAnswerFields(input);

      if (!existing) {
        try {
          const [created] = await ctx.db
            .insert(committeeApplications)
            .values({
              userId: ctx.session.user.id,
              cycle: COMMITTEE_CYCLE_ID,
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
        eq(committeeApplications.cycle, COMMITTEE_CYCLE_ID),
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

  list: adminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        ...applicationSelect,
        officerNotes: committeeApplications.officerNotes,
        name: users.name,
        email: users.email,
      })
      .from(committeeApplications)
      .innerJoin(users, eq(users.id, committeeApplications.userId))
      .where(eq(committeeApplications.cycle, COMMITTEE_CYCLE_ID))
      .orderBy(desc(committeeApplications.submittedAt));
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

  exportCycle: adminProcedure.query(async ({ ctx }) => {
    assertRateLimit(
      `export-committee:${ctx.session.user.id}`,
      EXPORT_COMMITTEE_LIMIT,
    );

    const rows = await ctx.db
      .select({
        name: users.name,
        email: users.email,
        discordHandle: committeeApplications.discordHandle,
        wantsEvents: committeeApplications.wantsEvents,
        wantsMarketing: committeeApplications.wantsMarketing,
        wantsTreasury: committeeApplications.wantsTreasury,
        eventsWhy: committeeApplications.eventsWhy,
        eventsCollabs: committeeApplications.eventsCollabs,
        marketingWhy: committeeApplications.marketingWhy,
        marketingConnections: committeeApplications.marketingConnections,
        treasuryWhy: committeeApplications.treasuryWhy,
        otherOrgs: committeeApplications.otherOrgs,
        comments: committeeApplications.comments,
        status: committeeApplications.status,
        officerNotes: committeeApplications.officerNotes,
        submittedAt: committeeApplications.submittedAt,
      })
      .from(committeeApplications)
      .innerJoin(users, eq(users.id, committeeApplications.userId))
      .where(eq(committeeApplications.cycle, COMMITTEE_CYCLE_ID))
      .orderBy(desc(committeeApplications.submittedAt))
      .limit(5000);

    return { rows, truncated: rows.length >= 5000 };
  }),
});
