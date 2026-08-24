import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "../errors";
import {
  assertRateLimit,
  MENTORSHIP_AWARD_LIMIT,
  MENTORSHIP_ENROLL_LIMIT,
} from "../rate-limit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { mentorshipEnrollments, users } from "@buzz/db";

const roleSchema = z.enum(["mentor", "mentee"]);
const statusSchema = z.enum(["interested", "enrolled", "withdrawn"]);

export const mentorshipRouter = createTRPCRouter({
  mine: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: eq(mentorshipEnrollments.userId, ctx.session.user.id),
    });
    return row ?? null;
  }),

  /**
   * Member signup. Interested until an officer enrolls them. Event points
   * stay on the card; these points live only on this row.
   */
  expressInterest: protectedProcedure
    .input(
      z.object({
        role: roleSchema,
        note: z.string().trim().max(400).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `mentorship-enroll:${ctx.session.user.id}`,
        MENTORSHIP_ENROLL_LIMIT,
      );

      const existing = await ctx.db.query.mentorshipEnrollments.findFirst({
        where: eq(mentorshipEnrollments.userId, ctx.session.user.id),
      });

      if (existing?.status === "enrolled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are already enrolled. Ask an officer to change this.",
        });
      }

      const note = input.note || null;

      if (!existing) {
        const [created] = await ctx.db
          .insert(mentorshipEnrollments)
          .values({
            userId: ctx.session.user.id,
            role: input.role,
            status: "interested",
            note,
          })
          .returning();
        return created;
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set({
          role: input.role,
          status: "interested",
          note,
        })
        .where(eq(mentorshipEnrollments.userId, ctx.session.user.id))
        .returning();
      return updated;
    }),

  withdraw: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `mentorship-enroll:${ctx.session.user.id}`,
      MENTORSHIP_ENROLL_LIMIT,
    );

    const existing = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: eq(mentorshipEnrollments.userId, ctx.session.user.id),
    });

    if (!existing) {
      notFound("Signup");
    }
    if (existing.status === "enrolled") {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You are enrolled. Ask an officer to take you off the list.",
      });
    }

    const [updated] = await ctx.db
      .update(mentorshipEnrollments)
      .set({ status: "withdrawn" })
      .where(eq(mentorshipEnrollments.userId, ctx.session.user.id))
      .returning();
    return updated;
  }),

  list: adminProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        userId: mentorshipEnrollments.userId,
        role: mentorshipEnrollments.role,
        status: mentorshipEnrollments.status,
        note: mentorshipEnrollments.note,
        points: mentorshipEnrollments.points,
        enrolledAt: mentorshipEnrollments.enrolledAt,
        createdAt: mentorshipEnrollments.createdAt,
        name: users.name,
        email: users.email,
      })
      .from(mentorshipEnrollments)
      .innerJoin(users, eq(users.id, mentorshipEnrollments.userId))
      .orderBy(desc(mentorshipEnrollments.updatedAt));
  }),

  setStatus: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        status: statusSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ userId: mentorshipEnrollments.userId })
        .from(mentorshipEnrollments)
        .where(eq(mentorshipEnrollments.userId, input.userId));

      if (!existing) {
        notFound("Signup");
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set(
          input.status === "enrolled"
            ? { status: input.status, enrolledAt: new Date() }
            : input.status === "withdrawn"
              ? { status: input.status, enrolledAt: null }
              : { status: input.status },
        )
        .where(eq(mentorshipEnrollments.userId, input.userId))
        .returning();
      return updated;
    }),

  awardPoints: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        points: z.number().int().min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `mentorship-award:${ctx.session.user.id}`,
        MENTORSHIP_AWARD_LIMIT,
      );

      const [existing] = await ctx.db
        .select({
          userId: mentorshipEnrollments.userId,
          points: mentorshipEnrollments.points,
        })
        .from(mentorshipEnrollments)
        .where(eq(mentorshipEnrollments.userId, input.userId));

      if (!existing) {
        notFound("Signup");
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set({ points: existing.points + input.points })
        .where(eq(mentorshipEnrollments.userId, input.userId))
        .returning();
      return updated;
    }),
});
