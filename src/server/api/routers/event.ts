import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";

import {
  adminProcedure,
  createTRPCRouter,
  protectedProcedure,
} from "~/server/api/trpc";
import { eventCheckIns, events, users } from "~/server/db/schema";

/**
 * How long after an event starts the door stays open. The member-facing list
 * stops advertising an event past this point, and check-in has to agree — or a
 * photographed code keeps admitting people weeks later.
 */
const CHECK_IN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Crockford-style base32: no I, L, O, U, 0 or 1. Members read these codes off a
 * projector and type them on a phone, so every ambiguous glyph is a support
 * ticket.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

function newCheckInCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

/** "  ab-cd ef " -> "ABCDEF". Members retype these, so be forgiving. */
function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Postgres unique_violation. Drizzle wraps every driver error, and the pg error
 * carrying the SQLSTATE sits on `.cause`, so the chain has to be walked —
 * checking only the top-level object silently never matches in production.
 */
function isUniqueViolation(error: unknown) {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    if (typeof cursor !== "object") break;
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Columns safe to hand a member. `checkInCode` is a bearer credential and is
 * absent on purpose — spreading the whole row anywhere member-facing is how it
 * would leak.
 */
const publicEventColumns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startsAt: events.startsAt,
  pointsValue: events.pointsValue,
  checkInEnabled: events.checkInEnabled,
} as const;

const totalsColumns = {
  totalEvents: sql<number>`count(*)::int`,
  totalPoints: sql<number>`coalesce(sum(${eventCheckIns.pointsEarned}), 0)::int`,
} as const;

const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  location: z.string().trim().max(200).optional(),
  startsAt: z.coerce.date(),
  pointsValue: z.number().int().min(0).max(100),
  maxCheckIns: z.number().int().positive().max(10000).nullable().optional(),
});

export const eventRouter = createTRPCRouter({
  // ---------------------------------------------------------------- officers

  create: adminProcedure.input(eventInput).mutation(async ({ ctx, input }) => {
    const [created] = await ctx.db
      .insert(events)
      .values({
        ...input,
        maxCheckIns: input.maxCheckIns ?? null,
        checkInCode: newCheckInCode(),
        createdById: ctx.session.user.id,
      })
      .returning();

    if (!created) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not create that event.",
      });
    }
    return created;
  }),

  update: adminProcedure
    .input(eventInput.extend({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      // Editing pointsValue changes what FUTURE attendance is worth. Rows
      // already written keep the value they were stamped with.
      const [updated] = await ctx.db
        .update(events)
        .set({ ...fields, maxCheckIns: fields.maxCheckIns ?? null })
        .where(eq(events.id, id))
        .returning();

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }
      return updated;
    }),

  /** Every event with its attendance count, in one query rather than N+1. */
  listAll: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        ...publicEventColumns,
        checkInCode: events.checkInCode,
        maxCheckIns: events.maxCheckIns,
        archivedAt: events.archivedAt,
        attendees: count(eventCheckIns.id),
      })
      .from(events)
      .leftJoin(eventCheckIns, eq(eventCheckIns.eventId, events.id))
      .groupBy(events.id)
      .orderBy(desc(events.startsAt))
      .limit(200);

    // Decided here rather than in the component: reading the clock during
    // render makes the list re-sort itself on an unrelated re-render, and this
    // is the same cutoff the check-in door uses.
    const cutoff = Date.now() - CHECK_IN_WINDOW_MS;
    return rows.map((row) => ({
      ...row,
      isPast: row.startsAt.getTime() < cutoff,
    }));
  }),

  /** One event plus its attendance roster — the officer's door list. */
  getById: adminProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.id),
      });

      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }

      const roster = await ctx.db
        .select({
          userId: eventCheckIns.userId,
          name: users.name,
          email: users.email,
          method: eventCheckIns.method,
          pointsEarned: eventCheckIns.pointsEarned,
          checkedInAt: eventCheckIns.checkedInAt,
        })
        .from(eventCheckIns)
        .innerJoin(users, eq(users.id, eventCheckIns.userId))
        .where(eq(eventCheckIns.eventId, event.id))
        .orderBy(desc(eventCheckIns.checkedInAt));

      return { event, roster };
    }),

  setCheckInEnabled: adminProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(events)
        .set({ checkInEnabled: input.enabled })
        .where(eq(events.id, input.id))
        .returning({ id: events.id, checkInEnabled: events.checkInEnabled });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }
      return updated;
    }),

  setArchived: adminProcedure
    .input(z.object({ id: z.string(), archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(events)
        .set({ archivedAt: input.archived ? new Date() : null })
        .where(eq(events.id, input.id))
        .returning({ id: events.id, archivedAt: events.archivedAt });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }
      return updated;
    }),

  /** Revocation: rotating the code kills a photographed poster immediately. */
  regenerateCode: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [updated] = await ctx.db
        .update(events)
        .set({ checkInCode: newCheckInCode() })
        .where(eq(events.id, input.id))
        .returning({ id: events.id, checkInCode: events.checkInCode });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }
      return updated;
    }),

  /** For the member whose phone died. Same snapshot rule as the code path. */
  manualCheckIn: adminProcedure
    .input(z.object({ eventId: z.string(), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      const email = input.email.trim().toLowerCase();

      const member = await ctx.db.query.users.findFirst({
        where: eq(users.email, email),
        columns: { id: true, name: true, email: true },
      });

      if (!member) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Nobody has signed in with that email yet.",
        });
      }

      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.eventId),
      });

      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }

      try {
        await ctx.db.transaction(async (tx) => {
          await tx.insert(eventCheckIns).values({
            eventId: event.id,
            userId: member.id,
            method: "manual",
            pointsEarned: event.pointsValue,
          });
          await tx
            .update(events)
            .set({ currentCheckIns: sql`${events.currentCheckIns} + 1` })
            .where(eq(events.id, event.id));
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${member.name ?? member.email} is already checked in.`,
          });
        }
        throw error;
      }

      return { name: member.name, email: member.email };
    }),

  /** Mis-scans happen; without this an officer cannot undo one. */
  removeCheckIn: adminProcedure
    .input(z.object({ eventId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        const removed = await tx
          .delete(eventCheckIns)
          .where(
            and(
              eq(eventCheckIns.eventId, input.eventId),
              eq(eventCheckIns.userId, input.userId),
            ),
          )
          .returning({ id: eventCheckIns.id });

        if (removed.length === 0) return;

        // greatest(): the counter is repaired by the same statement that
        // consumes it, so a hand-edited row can never drive it negative.
        await tx
          .update(events)
          .set({
            currentCheckIns: sql`greatest(${events.currentCheckIns} - 1, 0)`,
          })
          .where(eq(events.id, input.eventId));
      });

      return { success: true };
    }),

  // ----------------------------------------------------------------- members

  /**
   * The door.
   *
   * Guard order is load-bearing, and every hackathon-specific gate query had is
   * gone: membership is free here, so being signed in IS the membership check.
   */
  checkIn: protectedProcedure
    .input(z.object({ code: z.string().min(4).max(16) }))
    .mutation(async ({ ctx, input }) => {
      const code = normalizeCode(input.code);
      const userId = ctx.session.user.id;

      return ctx.db.transaction(async (tx) => {
        const event = await tx.query.events.findFirst({
          where: eq(events.checkInCode, code),
        });

        if (!event) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "That code is not valid.",
          });
        }

        if (event.archivedAt !== null || !event.checkInEnabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Check-in is closed for this event.",
          });
        }

        if (event.startsAt.getTime() < Date.now() - CHECK_IN_WINDOW_MS) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Check-in for this event has closed.",
          });
        }

        // Every guard below reads state this transaction is about to change.
        // Locking the event row first is what makes them hold: two phones
        // otherwise decide on identical snapshots, so a capped event overshoots.
        const [locked] = await tx
          .select({ currentCheckIns: events.currentCheckIns })
          .from(events)
          .where(eq(events.id, event.id))
          .for("update");

        const existing = await tx.query.eventCheckIns.findFirst({
          where: and(
            eq(eventCheckIns.eventId, event.id),
            eq(eventCheckIns.userId, userId),
          ),
        });

        // Tested before capacity on purpose: somebody already inside is a
        // duplicate, not an extra body, so a member re-tapping at a full event
        // is told they are already in rather than that the event is full.
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "You are already checked in to this event.",
          });
        }

        if (
          event.maxCheckIns !== null &&
          (locked?.currentCheckIns ?? 0) >= event.maxCheckIns
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This event is full.",
          });
        }

        try {
          // pointsEarned is snapshotted here and never recomputed. Re-pricing
          // the event later moves nobody's existing total.
          await tx.insert(eventCheckIns).values({
            eventId: event.id,
            userId,
            method: "code",
            pointsEarned: event.pointsValue,
          });
        } catch (error) {
          // The read above only rules out rows committed before this
          // transaction began; the unique constraint is what settles a true
          // double tap, and the loser has to read as the same conflict a
          // sequential retry gets rather than an unexplained failure.
          if (isUniqueViolation(error)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "You are already checked in to this event.",
            });
          }
          throw error;
        }

        // The counter is the capacity, so the increment re-tests it in the same
        // statement. A phone that got past the gate on a stale count finds no
        // row left to claim, and throwing takes its attendance row down with
        // the transaction.
        const claimed = await tx
          .update(events)
          .set({ currentCheckIns: sql`${events.currentCheckIns} + 1` })
          .where(
            event.maxCheckIns !== null
              ? and(
                  eq(events.id, event.id),
                  lt(events.currentCheckIns, event.maxCheckIns),
                )
              : eq(events.id, event.id),
          )
          .returning({ id: events.id });

        if (event.maxCheckIns !== null && claimed.length === 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This event is full.",
          });
        }

        const [totals] = await tx
          .select(totalsColumns)
          .from(eventCheckIns)
          .where(eq(eventCheckIns.userId, userId));

        return {
          eventTitle: event.title,
          pointsEarned: event.pointsValue,
          totalPoints: totals?.totalPoints ?? 0,
          totalEvents: totals?.totalEvents ?? 0,
        };
      });
    }),

  /** Everything this member has been to. One join, points already snapshotted. */
  myEvents: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db
      .select({
        id: events.id,
        title: events.title,
        location: events.location,
        startsAt: events.startsAt,
        pointsEarned: eventCheckIns.pointsEarned,
        method: eventCheckIns.method,
        checkedInAt: eventCheckIns.checkedInAt,
      })
      .from(eventCheckIns)
      .innerJoin(events, eq(events.id, eventCheckIns.eventId))
      .where(eq(eventCheckIns.userId, ctx.session.user.id))
      .orderBy(desc(eventCheckIns.checkedInAt))
      .limit(100);
  }),

  /** One aggregate row, one index scan. Nothing sums in JavaScript. */
  myStats: protectedProcedure.query(async ({ ctx }) => {
    const [totals] = await ctx.db
      .select(totalsColumns)
      .from(eventCheckIns)
      .where(eq(eventCheckIns.userId, ctx.session.user.id));

    return {
      totalEvents: totals?.totalEvents ?? 0,
      totalPoints: totals?.totalPoints ?? 0,
    };
  }),

  /** What is still open, marked with whether this member has already been. */
  upcoming: protectedProcedure.query(async ({ ctx }) => {
    const cutoff = new Date(Date.now() - CHECK_IN_WINDOW_MS);

    return ctx.db
      .select({
        ...publicEventColumns,
        attendedAt: eventCheckIns.checkedInAt,
      })
      .from(events)
      .leftJoin(
        eventCheckIns,
        and(
          eq(eventCheckIns.eventId, events.id),
          eq(eventCheckIns.userId, ctx.session.user.id),
        ),
      )
      .where(and(isNull(events.archivedAt), gte(events.startsAt, cutoff)))
      .orderBy(asc(events.startsAt))
      .limit(20);
  }),
});
