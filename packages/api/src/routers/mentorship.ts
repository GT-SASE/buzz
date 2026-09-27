import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "../errors";
import { isUniqueViolation } from "../pg-errors";
import {
  assertRateLimit,
  MENTORSHIP_AWARD_LIMIT,
  MENTORSHIP_ENROLL_LIMIT,
} from "../rate-limit";
import {
  schoolYear,
  schoolYearOfSemester,
  semester,
  semesterPattern,
} from "../terms";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
  kinGroups,
  kinMemberships,
  mentorshipEnrollments,
  users,
} from "@buzz/db";

const roleSchema = z.enum(["mentor", "mentee"]);
const statusSchema = z.enum(["interested", "enrolled", "withdrawn"]);

/** Omitted means the current semester. Past semesters are read-only history. */
const semesterInput = z
  .object({ semester: z.string().regex(semesterPattern).optional() })
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
      message: "A kin group already has that name this semester.",
    });
  }
  throw error;
}

/** This school year's signup for one member. Points and role live here. */
const signupOf = (userId: string) =>
  and(
    eq(mentorshipEnrollments.userId, userId),
    eq(mentorshipEnrollments.year, schoolYear(new Date())),
  );

/** This semester's group seat for one member. */
const seatOf = (userId: string) =>
  and(
    eq(kinMemberships.userId, userId),
    eq(kinMemberships.semester, semester(new Date())),
  );

function inGroupThisSemester(): never {
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "You are in a kin group this semester. Leave it first.",
  });
}

export const mentorshipRouter = createTRPCRouter({
  /**
   * This school year's signup plus this semester's group, or null. Last
   * year's signup does not carry over; last semester's group does not either.
   */
  mine: protectedProcedure.query(async ({ ctx }) => {
    const [row, seat] = await Promise.all([
      ctx.db.query.mentorshipEnrollments.findFirst({
        where: signupOf(ctx.session.user.id),
      }),
      ctx.db.query.kinMemberships.findFirst({
        where: seatOf(ctx.session.user.id),
      }),
    ]);
    if (!row) return null;
    return { ...row, groupId: seat?.groupId ?? null };
  }),

  /** Signup for this school year. Role changes wait until you leave a group. */
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

      const [existing, seat] = await Promise.all([
        ctx.db.query.mentorshipEnrollments.findFirst({
          where: signupOf(ctx.session.user.id),
        }),
        ctx.db.query.kinMemberships.findFirst({
          where: seatOf(ctx.session.user.id),
        }),
      ]);
      if (seat) inGroupThisSemester();

      const note = input.note ?? null;

      if (!existing) {
        const [created] = await ctx.db
          .insert(mentorshipEnrollments)
          .values({
            userId: ctx.session.user.id,
            year: schoolYear(new Date()),
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
          status: existing.status === "enrolled" ? "enrolled" : "interested",
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

    const [existing, seat] = await Promise.all([
      ctx.db.query.mentorshipEnrollments.findFirst({
        where: signupOf(ctx.session.user.id),
      }),
      ctx.db.query.kinMemberships.findFirst({
        where: seatOf(ctx.session.user.id),
      }),
    ]);
    if (!existing) notFound("Signup");
    if (seat) inGroupThisSemester();

    const [updated] = await ctx.db
      .update(mentorshipEnrollments)
      .set({ status: "withdrawn", enrolledAt: null })
      .where(signupOf(ctx.session.user.id))
      .returning();
    return updated;
  }),

  /** Signups for the school year a semester falls in, with that semester's group. */
  list: adminProcedure.input(semesterInput).query(async ({ ctx, input }) => {
    const term = input?.semester ?? semester(new Date());
    const [rows, seats] = await Promise.all([
      ctx.db
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
        .where(eq(mentorshipEnrollments.year, schoolYearOfSemester(term)))
        .orderBy(desc(mentorshipEnrollments.updatedAt)),
      ctx.db
        .select({
          userId: kinMemberships.userId,
          groupId: kinMemberships.groupId,
        })
        .from(kinMemberships)
        .where(eq(kinMemberships.semester, term)),
    ]);
    const groupOf = new Map(seats.map((seat) => [seat.userId, seat.groupId]));
    return rows.map((row) => ({
      ...row,
      groupId: groupOf.get(row.userId) ?? null,
    }));
  }),

  /** Every semester with a signup or a group, newest first. */
  semesters: adminProcedure.query(async ({ ctx }) => {
    const [fromGroups, fromSignups] = await Promise.all([
      ctx.db.selectDistinct({ semester: kinGroups.semester }).from(kinGroups),
      ctx.db
        .selectDistinct({ year: mentorshipEnrollments.year })
        .from(mentorshipEnrollments),
    ]);
    const all = new Set([
      semester(new Date()),
      ...fromGroups.map((row) => row.semester),
      ...fromSignups.map((row) => `fall-${row.year.slice(0, 4)}`),
    ]);
    const order = (id: string) => {
      const [term, year] = id.split("-");
      return Number(year) * 2 + (term === "fall" ? 1 : 0);
    };
    return [...all].sort((a, b) => order(b) - order(a));
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
      if (!existing) notFound("Signup");

      return ctx.db.transaction(async (tx) => {
        if (input.status !== "enrolled") {
          await tx.delete(kinMemberships).where(seatOf(input.userId));
        }
        const [updated] = await tx
          .update(mentorshipEnrollments)
          .set(
            input.status === "enrolled"
              ? { status: input.status, enrolledAt: new Date() }
              : { status: input.status, enrolledAt: null },
          )
          .where(signupOf(input.userId))
          .returning();
        return updated;
      });
    }),

  /** Adds to the yearly total, and to this semester's group seat if any. */
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

      return ctx.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ points: mentorshipEnrollments.points })
          .from(mentorshipEnrollments)
          .where(signupOf(input.userId))
          .for("update");
        if (!existing) notFound("Signup");

        const [seat] = await tx
          .select({ points: kinMemberships.points })
          .from(kinMemberships)
          .where(seatOf(input.userId))
          .for("update");
        if (seat) {
          await tx
            .update(kinMemberships)
            .set({ points: seat.points + input.points })
            .where(seatOf(input.userId));
        }

        const [updated] = await tx
          .update(mentorshipEnrollments)
          .set({ points: existing.points + input.points })
          .where(signupOf(input.userId))
          .returning();
        return updated;
      });
    }),

  /**
   * One semester's groups with headcount and semester points. Mentor names
   * are shown so a mentee can choose; mentee names and emails stay inside.
   */
  groups: protectedProcedure
    .input(semesterInput)
    .query(async ({ ctx, input }) => {
      const term = input?.semester ?? semester(new Date());
      const [groups, seats] = await Promise.all([
        ctx.db
          .select()
          .from(kinGroups)
          .where(eq(kinGroups.semester, term))
          .orderBy(asc(kinGroups.name)),
        ctx.db
          .select({
            groupId: kinMemberships.groupId,
            points: kinMemberships.points,
            role: mentorshipEnrollments.role,
            name: users.name,
          })
          .from(kinMemberships)
          .innerJoin(users, eq(users.id, kinMemberships.userId))
          .innerJoin(
            mentorshipEnrollments,
            and(
              eq(mentorshipEnrollments.userId, kinMemberships.userId),
              eq(mentorshipEnrollments.year, schoolYearOfSemester(term)),
            ),
          )
          .where(eq(kinMemberships.semester, term)),
      ]);

      return groups.map((group) => {
        const inGroup = seats.filter((seat) => seat.groupId === group.id);
        return {
          id: group.id,
          semester: group.semester,
          name: group.name,
          description: group.description,
          capacity: group.capacity,
          isOpen: group.isOpen,
          memberCount: inGroup.length,
          points: inGroup.reduce((total, seat) => total + seat.points, 0),
          mentors: inGroup
            .filter((seat) => seat.role === "mentor")
            .map((seat) => seat.name ?? "Mentor"),
        };
      });
    }),

  /** The caller's group this semester and everyone in it, or null. */
  myGroup: protectedProcedure.query(async ({ ctx }) => {
    const seat = await ctx.db.query.kinMemberships.findFirst({
      where: seatOf(ctx.session.user.id),
    });
    if (!seat) return null;

    const [group] = await ctx.db
      .select()
      .from(kinGroups)
      .where(eq(kinGroups.id, seat.groupId));
    if (!group) return null;

    const members = await ctx.db
      .select({
        userId: kinMemberships.userId,
        role: mentorshipEnrollments.role,
        points: kinMemberships.points,
        name: users.name,
        email: users.email,
      })
      .from(kinMemberships)
      .innerJoin(users, eq(users.id, kinMemberships.userId))
      .innerJoin(
        mentorshipEnrollments,
        and(
          eq(mentorshipEnrollments.userId, kinMemberships.userId),
          eq(mentorshipEnrollments.year, group.year),
        ),
      )
      .where(eq(kinMemberships.groupId, group.id))
      .orderBy(desc(mentorshipEnrollments.role), asc(users.name));

    return {
      id: group.id,
      name: group.name,
      description: group.description,
      members,
    };
  }),

  /**
   * Self-serve join for this semester. The group row is locked first so two
   * members racing for the last seat cannot both take it.
   */
  joinGroup: protectedProcedure
    .input(z.object({ groupId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `mentorship-enroll:${ctx.session.user.id}`,
        MENTORSHIP_ENROLL_LIMIT,
      );
      const term = semester(new Date());

      return ctx.db.transaction(async (tx) => {
        const [group] = await tx
          .select()
          .from(kinGroups)
          .where(
            and(eq(kinGroups.id, input.groupId), eq(kinGroups.semester, term)),
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

        const [seat] = await tx
          .select({ groupId: kinMemberships.groupId })
          .from(kinMemberships)
          .where(seatOf(ctx.session.user.id));
        if (seat) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You are already in a kin group. Leave it first.",
          });
        }

        if (group.capacity !== null) {
          const [taken] = await tx
            .select({ n: count() })
            .from(kinMemberships)
            .where(eq(kinMemberships.groupId, group.id));
          if ((taken?.n ?? 0) >= group.capacity) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "That group is full.",
            });
          }
        }

        await tx.insert(kinMemberships).values({
          userId: ctx.session.user.id,
          semester: term,
          groupId: group.id,
        });
        const [updated] = await tx
          .update(mentorshipEnrollments)
          .set({ status: "enrolled", enrolledAt: new Date() })
          .where(signupOf(ctx.session.user.id))
          .returning();
        return updated;
      });
    }),

  /** Back to signed up. Yearly KIN points stay with the member. */
  leaveGroup: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `mentorship-enroll:${ctx.session.user.id}`,
      MENTORSHIP_ENROLL_LIMIT,
    );

    return ctx.db.transaction(async (tx) => {
      const removed = await tx
        .delete(kinMemberships)
        .where(seatOf(ctx.session.user.id))
        .returning({ groupId: kinMemberships.groupId });
      if (removed.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "You are not in a kin group.",
        });
      }
      const [updated] = await tx
        .update(mentorshipEnrollments)
        .set({ status: "interested", enrolledAt: null })
        .where(signupOf(ctx.session.user.id))
        .returning();
      return updated;
    });
  }),

  /** Always this semester. Past semesters' groups are not reopened. */
  createGroup: adminProcedure
    .input(groupInput)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      try {
        const [created] = await ctx.db
          .insert(kinGroups)
          .values({ ...input, year: schoolYear(now), semester: semester(now) })
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

  /** Members of a deleted group go back to signed up, points intact. */
  deleteGroup: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (tx) => {
        const [group] = await tx
          .select({ year: kinGroups.year })
          .from(kinGroups)
          .where(eq(kinGroups.id, input.id));
        if (!group) notFound("Kin group");

        const seats = await tx
          .delete(kinMemberships)
          .where(eq(kinMemberships.groupId, input.id))
          .returning({ userId: kinMemberships.userId });
        if (seats.length > 0) {
          await tx
            .update(mentorshipEnrollments)
            .set({ status: "interested", enrolledAt: null })
            .where(
              and(
                eq(mentorshipEnrollments.year, group.year),
                inArray(
                  mentorshipEnrollments.userId,
                  seats.map((seat) => seat.userId),
                ),
              ),
            );
        }
        await tx.delete(kinGroups).where(eq(kinGroups.id, input.id));
        return { id: input.id };
      });
    }),

  /**
   * Officer placement into a group from this semester. Ignores isOpen and
   * capacity on purpose. Null takes them out of their group.
   */
  assignGroup: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        groupId: z.string().min(1).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const term = semester(new Date());
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
            and(eq(kinGroups.id, input.groupId), eq(kinGroups.semester, term)),
          );
        if (!group) notFound("Kin group");
      }

      return ctx.db.transaction(async (tx) => {
        const [seat] = await tx
          .delete(kinMemberships)
          .where(seatOf(input.userId))
          .returning({ points: kinMemberships.points });
        if (input.groupId) {
          await tx.insert(kinMemberships).values({
            userId: input.userId,
            semester: term,
            groupId: input.groupId,
            points: seat?.points ?? 0,
          });
        }
        const [updated] = await tx
          .update(mentorshipEnrollments)
          .set(
            input.groupId
              ? { status: "enrolled", enrolledAt: new Date() }
              : { status: "interested", enrolledAt: null },
          )
          .where(signupOf(input.userId))
          .returning();
        return updated;
      });
    }),

  /** One tap after a group meeting: every member of the group. */
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
        const [group] = await tx
          .select({ year: kinGroups.year })
          .from(kinGroups)
          .where(eq(kinGroups.id, input.groupId));
        if (!group) notFound("Kin group");

        const seats = await tx
          .select({
            userId: kinMemberships.userId,
            semester: kinMemberships.semester,
            points: kinMemberships.points,
          })
          .from(kinMemberships)
          .where(eq(kinMemberships.groupId, input.groupId))
          .for("update");
        if (seats.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Nobody is in that group yet.",
          });
        }

        const totals = await tx
          .select({
            userId: mentorshipEnrollments.userId,
            points: mentorshipEnrollments.points,
          })
          .from(mentorshipEnrollments)
          .where(
            and(
              eq(mentorshipEnrollments.year, group.year),
              inArray(
                mentorshipEnrollments.userId,
                seats.map((seat) => seat.userId),
              ),
            ),
          )
          .for("update");

        for (const seat of seats) {
          await tx
            .update(kinMemberships)
            .set({ points: seat.points + input.points })
            .where(
              and(
                eq(kinMemberships.userId, seat.userId),
                eq(kinMemberships.semester, seat.semester),
              ),
            );
        }
        for (const total of totals) {
          await tx
            .update(mentorshipEnrollments)
            .set({ points: total.points + input.points })
            .where(
              and(
                eq(mentorshipEnrollments.userId, total.userId),
                eq(mentorshipEnrollments.year, group.year),
              ),
            );
        }
        return { awarded: seats.length };
      });
    }),
});
