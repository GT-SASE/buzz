import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "../errors";
import { kinYear, kinYearSchema } from "../kin-year";
import { isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  MENTORSHIP_AWARD_LIMIT,
  MENTORSHIP_ENROLL_LIMIT,
} from "../rate-limit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { kinGroups, mentorshipEnrollments, users } from "@buzz/db";

const roleSchema = z.enum(["mentor", "mentee"]);
const statusSchema = z.enum(["interested", "enrolled", "withdrawn"]);

/** Omitted means the current school year. Past years are read-only history. */
const yearInput = z
  .object({ year: z.string().regex(kinYearSchema).optional() })
  .nullish();

const groupInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z
    .string()
    .trim()
    .max(600)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : null)),
  capacity: z.number().int().min(1).max(100).nullable(),
  isOpen: z.boolean(),
});

function rethrowDuplicateName(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "A kin group already has that name this year.",
    });
  }
  throw error;
}

/** This school year's row for one member. Every write goes through here. */
const signupOf = (userId: string) =>
  and(
    eq(mentorshipEnrollments.userId, userId),
    eq(mentorshipEnrollments.year, kinYear(new Date())),
  );

const enrolledIn = (groupId: string) =>
  and(
    eq(mentorshipEnrollments.groupId, groupId),
    eq(mentorshipEnrollments.status, "enrolled"),
  );

export const mentorshipRouter = createTRPCRouter({
  /** This year's signup, or null — last year's does not carry over. */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: signupOf(ctx.session.user.id),
    });
    return row ?? null;
  }),

  /**
   * Member signup for this school year. Event points stay on the card; these
   * points live only on this row.
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
        where: signupOf(ctx.session.user.id),
      });

      if (existing?.status === "enrolled") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are already enrolled. Ask an officer to change this.",
        });
      }

      const note = input.note ?? null;

      if (!existing) {
        const [created] = await ctx.db
          .insert(mentorshipEnrollments)
          .values({
            userId: ctx.session.user.id,
            year: kinYear(new Date()),
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
        .where(signupOf(ctx.session.user.id))
        .returning();
      return updated;
    }),

  withdraw: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `mentorship-enroll:${ctx.session.user.id}`,
      MENTORSHIP_ENROLL_LIMIT,
    );

    const existing = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: signupOf(ctx.session.user.id),
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
      .where(signupOf(ctx.session.user.id))
      .returning();
    return updated;
  }),

  list: adminProcedure.input(yearInput).query(async ({ ctx, input }) => {
    return ctx.db
      .select({
        userId: mentorshipEnrollments.userId,
        role: mentorshipEnrollments.role,
        status: mentorshipEnrollments.status,
        note: mentorshipEnrollments.note,
        points: mentorshipEnrollments.points,
        groupId: mentorshipEnrollments.groupId,
        enrolledAt: mentorshipEnrollments.enrolledAt,
        createdAt: mentorshipEnrollments.createdAt,
        name: users.name,
        email: users.email,
      })
      .from(mentorshipEnrollments)
      .innerJoin(users, eq(users.id, mentorshipEnrollments.userId))
      .where(eq(mentorshipEnrollments.year, input?.year ?? kinYear(new Date())))
      .orderBy(desc(mentorshipEnrollments.updatedAt));
  }),

  /** Every school year with a signup or a group, newest first. */
  years: adminProcedure.query(async ({ ctx }) => {
    const [fromSignups, fromGroups] = await Promise.all([
      ctx.db
        .selectDistinct({ year: mentorshipEnrollments.year })
        .from(mentorshipEnrollments),
      ctx.db.selectDistinct({ year: kinGroups.year }).from(kinGroups),
    ]);
    const all = new Set([
      kinYear(new Date()),
      ...fromSignups.map((row) => row.year),
      ...fromGroups.map((row) => row.year),
    ]);
    return [...all].sort().reverse();
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
        .where(signupOf(input.userId));

      if (!existing) {
        notFound("Signup");
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set(
          input.status === "enrolled"
            ? { status: input.status, enrolledAt: new Date() }
            : { status: input.status, enrolledAt: null, groupId: null },
        )
        .where(signupOf(input.userId))
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
        .where(signupOf(input.userId));

      if (!existing) {
        notFound("Signup");
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set({ points: existing.points + input.points })
        .where(signupOf(input.userId))
        .returning();
      return updated;
    }),

  /**
   * One school year's groups with headcount and points. Mentor names are
   * shown so a mentee can choose; mentee names and emails stay in the group.
   */
  groups: protectedProcedure.input(yearInput).query(async ({ ctx, input }) => {
    const year = input?.year ?? kinYear(new Date());
    const [groups, members] = await Promise.all([
      ctx.db
        .select()
        .from(kinGroups)
        .where(eq(kinGroups.year, year))
        .orderBy(asc(kinGroups.name)),
      ctx.db
        .select({
          groupId: mentorshipEnrollments.groupId,
          role: mentorshipEnrollments.role,
          points: mentorshipEnrollments.points,
          name: users.name,
        })
        .from(mentorshipEnrollments)
        .innerJoin(users, eq(users.id, mentorshipEnrollments.userId))
        .where(
          and(
            eq(mentorshipEnrollments.year, year),
            eq(mentorshipEnrollments.status, "enrolled"),
          ),
        ),
    ]);

    return groups.map((group) => {
      const inGroup = members.filter((member) => member.groupId === group.id);
      return {
        id: group.id,
        year: group.year,
        name: group.name,
        description: group.description,
        capacity: group.capacity,
        isOpen: group.isOpen,
        memberCount: inGroup.length,
        points: inGroup.reduce((total, member) => total + member.points, 0),
        mentors: inGroup
          .filter((member) => member.role === "mentor")
          .map((member) => member.name ?? "Mentor"),
      };
    });
  }),

  /** The caller's group this year and everyone in it, or null. */
  myGroup: protectedProcedure.query(async ({ ctx }) => {
    const mine = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: signupOf(ctx.session.user.id),
    });
    if (!mine?.groupId || mine.status !== "enrolled") return null;

    const [group] = await ctx.db
      .select()
      .from(kinGroups)
      .where(eq(kinGroups.id, mine.groupId));
    if (!group) return null;

    const members = await ctx.db
      .select({
        userId: mentorshipEnrollments.userId,
        role: mentorshipEnrollments.role,
        points: mentorshipEnrollments.points,
        name: users.name,
        email: users.email,
      })
      .from(mentorshipEnrollments)
      .innerJoin(users, eq(users.id, mentorshipEnrollments.userId))
      .where(enrolledIn(group.id))
      .orderBy(desc(mentorshipEnrollments.role), asc(users.name));

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      members,
    };
  }),

  /**
   * Self-serve join. The group row is locked first so two members racing for
   * the last seat cannot both take it.
   */
  joinGroup: protectedProcedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `mentorship-enroll:${ctx.session.user.id}`,
        MENTORSHIP_ENROLL_LIMIT,
      );

      return ctx.db.transaction(async (tx) => {
        const [group] = await tx
          .select()
          .from(kinGroups)
          .where(
            and(
              eq(kinGroups.id, input.groupId),
              eq(kinGroups.year, kinYear(new Date())),
            ),
          )
          .for("update");
        if (!group) notFound("Kin group");
        if (!group.isOpen) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "That group is invite-only. Ask an officer to place you.",
          });
        }

        const [mine] = await tx
          .select()
          .from(mentorshipEnrollments)
          .where(signupOf(ctx.session.user.id))
          .for("update");
        if (!mine || mine.status === "withdrawn") {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Sign up as a mentor or mentee first.",
          });
        }
        if (mine.groupId) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You are already in a kin group. Leave it first.",
          });
        }

        if (group.capacity !== null) {
          const [taken] = await tx
            .select({ n: count() })
            .from(mentorshipEnrollments)
            .where(enrolledIn(group.id));
          if ((taken?.n ?? 0) >= group.capacity) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "That group is full.",
            });
          }
        }

        const [updated] = await tx
          .update(mentorshipEnrollments)
          .set({
            groupId: group.id,
            status: "enrolled",
            enrolledAt: new Date(),
          })
          .where(signupOf(ctx.session.user.id))
          .returning();
        return updated;
      });
    }),

  /** Back to interested. KIN points belong to the member, so they stay. */
  leaveGroup: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `mentorship-enroll:${ctx.session.user.id}`,
      MENTORSHIP_ENROLL_LIMIT,
    );

    const existing = await ctx.db.query.mentorshipEnrollments.findFirst({
      where: signupOf(ctx.session.user.id),
    });
    if (!existing?.groupId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You are not in a kin group.",
      });
    }

    const [updated] = await ctx.db
      .update(mentorshipEnrollments)
      .set({ groupId: null, status: "interested", enrolledAt: null })
      .where(signupOf(ctx.session.user.id))
      .returning();
    return updated;
  }),

  /** Always this school year. Last year's groups are not reopened. */
  createGroup: adminProcedure
    .input(groupInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const [created] = await ctx.db
          .insert(kinGroups)
          .values({
            ...input,
            year: kinYear(new Date()),
          })
          .returning();
        return created;
      } catch (error) {
        rethrowDuplicateName(error);
      }
    }),

  updateGroup: adminProcedure
    .input(groupInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      let updated;
      try {
        [updated] = await ctx.db
          .update(kinGroups)
          .set(fields)
          .where(eq(kinGroups.id, id))
          .returning();
      } catch (error) {
        rethrowDuplicateName(error);
      }
      if (!updated) notFound("Kin group");
      return updated;
    }),

  /** Members of a deleted group go back to interested, points intact. */
  deleteGroup: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        await tx
          .update(mentorshipEnrollments)
          .set({ groupId: null, status: "interested", enrolledAt: null })
          .where(eq(mentorshipEnrollments.groupId, input.id));
        const [deleted] = await tx
          .delete(kinGroups)
          .where(eq(kinGroups.id, input.id))
          .returning({ id: kinGroups.id });
        if (!deleted) notFound("Kin group");
        return deleted;
      });
    }),

  /**
   * Officer placement into a group from this school year. Ignores isOpen and
   * capacity on purpose — an officer can seat someone in a full or
   * invite-only group. Null takes them out.
   */
  assignGroup: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        groupId: z.string().min(1).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [existing] = await ctx.db
        .select({ userId: mentorshipEnrollments.userId })
        .from(mentorshipEnrollments)
        .where(signupOf(input.userId));
      if (!existing) notFound("Signup");

      if (input.groupId) {
        const [group] = await ctx.db
          .select({ id: kinGroups.id })
          .from(kinGroups)
          .where(
            and(
              eq(kinGroups.id, input.groupId),
              eq(kinGroups.year, kinYear(new Date())),
            ),
          );
        if (!group) notFound("Kin group");
      }

      const [updated] = await ctx.db
        .update(mentorshipEnrollments)
        .set(
          input.groupId
            ? {
                groupId: input.groupId,
                status: "enrolled",
                enrolledAt: new Date(),
              }
            : { groupId: null, status: "interested", enrolledAt: null },
        )
        .where(signupOf(input.userId))
        .returning();
      return updated;
    }),

  /** One tap after a family meeting: every enrolled member of the group. */
  awardGroupPoints: adminProcedure
    .input(
      z.object({
        groupId: z.string().min(1),
        points: z.number().int().min(1).max(50),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `mentorship-award:${ctx.session.user.id}`,
        MENTORSHIP_AWARD_LIMIT,
      );

      return ctx.db.transaction(async (tx) => {
        const rows = await tx
          .select({
            userId: mentorshipEnrollments.userId,
            year: mentorshipEnrollments.year,
            points: mentorshipEnrollments.points,
          })
          .from(mentorshipEnrollments)
          .where(enrolledIn(input.groupId))
          .for("update");
        if (rows.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Nobody is in that group yet.",
          });
        }

        for (const row of rows) {
          await tx
            .update(mentorshipEnrollments)
            .set({ points: row.points + input.points })
            .where(
              and(
                eq(mentorshipEnrollments.userId, row.userId),
                eq(mentorshipEnrollments.year, row.year),
              ),
            );
        }
        return { awarded: rows.length };
      });
    }),
});
