import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";

import { asDate, asInt, totalsColumns } from "../aggregates";
import { isUniqueViolation } from "../pg-errors";
import {
  CHECK_IN_LIMIT,
  MANUAL_CHECK_IN_LIMIT,
  REGENERATE_CODE_LIMIT,
  takeToken,
} from "../rate-limit";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import { eventCheckIns, events, users } from "@buzz/db";

/**
 * How long after an event starts the door stays open. The member-facing list
 * stops advertising an event past this point, and check-in has to agree — or a
 * photographed code keeps admitting people weeks later.
 */
const CHECK_IN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How early before start members may check in. */
const CHECK_IN_GRACE_MS = 2 * 60 * 60 * 1000;

const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Crockford-style base32: no I, L, O, U, 0 or 1. Members read these codes off a
 * projector and type them on a phone, so every ambiguous glyph is a support
 * ticket.
 */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

function newCheckInCode() {
  const alphabetLen = CODE_ALPHABET.length;
  const rejectAbove = 256 - (256 % alphabetLen);
  let code = "";
  while (code.length < CODE_LENGTH) {
    const bytes = new Uint8Array(CODE_LENGTH - code.length);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      // Rejection sampling: `byte % length` alone biases the shorter alphabet.
      if (byte >= rejectAbove) continue;
      code += CODE_ALPHABET[byte % alphabetLen];
      if (code.length >= CODE_LENGTH) break;
    }
  }
  return code;
}

/** "  ab-cd ef " -> "ABCDEF". Members retype these, so be forgiving. */
function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function assertCheckInWindow(startsAt: Date) {
  const now = Date.now();
  if (startsAt.getTime() - CHECK_IN_GRACE_MS > now) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check-in has not opened yet.",
    });
  }
  if (startsAt.getTime() < now - CHECK_IN_WINDOW_MS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check-in for this event has closed.",
    });
  }
}

function assertRateLimit(key: string, options: Parameters<typeof takeToken>[1]) {
  if (!takeToken(key, options)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Try again shortly.",
    });
  }
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

const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  location: z.string().trim().max(200).optional(),
  startsAt: z.coerce.date().refine((date) => {
    const t = date.getTime();
    if (Number.isNaN(t)) return false;
    const now = Date.now();
    return t >= now - TWO_YEARS_MS && t <= now + TWO_YEARS_MS;
  }, "Event start must be within two years of today."),
  pointsValue: z.number().int().min(0).max(100),
  maxCheckIns: z.number().int().positive().max(10000).nullable().optional(),
});

export const eventRouter = createTRPCRouter({
  // ---------------------------------------------------------------- officers

  create: adminProcedure.input(eventInput).mutation(async ({ ctx, input }) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
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
      } catch (error) {
        if (!isUniqueViolation(error) || attempt === 4) {
          if (isUniqueViolation(error)) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Could not create that event.",
            });
          }
          throw error;
        }
      }
    }

    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not create that event.",
    });
  }),

  update: adminProcedure
    .input(eventInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      // Editing pointsValue changes what FUTURE attendance is worth. Rows
      // already written keep the value they were stamped with.
      //
      // Every nullable column is coerced to an explicit null, because Drizzle
      // strips `undefined` out of the update set entirely. Without this,
      // clearing an event's location or description silently does nothing: the
      // column is simply absent from the UPDATE, the mutation reports success,
      // and the old text keeps rendering to members.
      const capacity = fields.maxCheckIns ?? null;

      // Uncapped check-ins skip the counter entirely, because a shared counter
      // is a row every scanner has to serialise on. So the moment a capacity is
      // added the counter may be stale, and the gate it feeds would admit past
      // the limit. Recomputing it from the rows that actually exist is what
      // makes the fast path safe to turn back off.
      //
      // The recount is a subquery inside this UPDATE, not a separate SELECT
      // before it: two statements leave a window where a check-in inserted
      // between them is counted by neither, and since this counter IS the
      // capacity gate, a count low by k inflates the cap by k for the life of
      // the event.
      // Lock + recount in one transaction so a check-in between SELECT and
      // UPDATE cannot leave the counter low of the real attendance.
      const updated = await ctx.db.transaction(async (tx) => {
        const [locked] = await tx
          .select({ id: events.id })
          .from(events)
          .where(eq(events.id, id))
          .for("update");

        if (!locked) return null;

        const [attendance] = await tx
          .select({ total: count() })
          .from(eventCheckIns)
          .where(eq(eventCheckIns.eventId, id));

        const [row] = await tx
          .update(events)
          .set({
            ...fields,
            description: fields.description ?? null,
            location: fields.location ?? null,
            maxCheckIns: capacity,
            ...(capacity === null
              ? {}
              : {
                  currentCheckIns:
                    typeof attendance?.total === "number"
                      ? attendance.total
                      : Number(attendance?.total ?? 0),
                }),
          })
          .where(eq(events.id, id))
          .returning();

        return row ?? null;
      });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }
      return updated;
    }),

  /** Every event with its attendance count, in one query rather than N+1. */
  listAll: adminProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [rows, [totals]] = await Promise.all([
        ctx.db
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
          .limit(input.limit)
          .offset(input.offset),
        ctx.db.select({ total: count() }).from(events),
      ]);

      // Decided here rather than in the component: reading the clock during
      // render makes the list re-sort itself on an unrelated re-render, and this
      // is the same cutoff the check-in door uses.
      const cutoff = Date.now() - CHECK_IN_WINDOW_MS;
      return {
        events: rows.map((row) => ({
          ...row,
          isPast: row.startsAt.getTime() < cutoff,
        })),
        total:
          typeof totals?.total === "number"
            ? totals.total
            : Number(totals?.total ?? 0),
      };
    }),

  /** One event plus its attendance roster — the officer's door list. */
  getById: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.id),
      });

      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }

      const [roster, [rosterCount]] = await Promise.all([
        ctx.db
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
          .orderBy(desc(eventCheckIns.checkedInAt))
          .limit(input.limit)
          .offset(input.offset),
        ctx.db
          .select({ total: count() })
          .from(eventCheckIns)
          .where(eq(eventCheckIns.eventId, event.id)),
      ]);

      // The officer screen shows whether the door is open. Without this it can
      // only see `checkInEnabled` and would keep advertising a code that
      // `checkIn` has already started refusing on the 24-hour window alone.
      const isPast = event.startsAt.getTime() < Date.now() - CHECK_IN_WINDOW_MS;

      return {
        event,
        roster,
        rosterTotal:
          typeof rosterCount?.total === "number"
            ? rosterCount.total
            : Number(rosterCount?.total ?? 0),
        isPast,
      };
    }),

  /** Full attendance for CSV. Capped so an uncapped event cannot OOM the handler. */
  exportAttendance: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.id),
        columns: { id: true },
      });

      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Event not found." });
      }

      const rows = await ctx.db
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
        .orderBy(desc(eventCheckIns.checkedInAt))
        .limit(5000);

      return { rows, truncated: rows.length >= 5000 };
    }),

  setCheckInEnabled: adminProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
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
    .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
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
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `regenerate-code:${ctx.session.user.id}`,
        REGENERATE_CODE_LIMIT,
      );

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const [updated] = await ctx.db
            .update(events)
            .set({ checkInCode: newCheckInCode() })
            .where(eq(events.id, input.id))
            .returning({ id: events.id, checkInCode: events.checkInCode });

          if (!updated) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Event not found.",
            });
          }
          return updated;
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          if (!isUniqueViolation(error) || attempt === 4) {
            if (isUniqueViolation(error)) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Could not regenerate that code.",
              });
            }
            throw error;
          }
        }
      }

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not regenerate that code.",
      });
    }),

  /** For the member whose phone died. Same snapshot rule as the code path. */
  manualCheckIn: adminProcedure
    .input(
      z.object({ eventId: z.string().min(1), email: z.string().email() }),
    )
    .mutation(async ({ ctx, input }) => {
      assertRateLimit(
        `manual-check-in:${ctx.session.user.id}`,
        MANUAL_CHECK_IN_LIMIT,
      );

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

      try {
        await ctx.db.transaction(async (tx) => {
          // Re-read under the same lock the capacity path uses so a concurrent
          // archive / re-price cannot race the insert.
          const [locked] = await tx
            .select()
            .from(events)
            .where(eq(events.id, input.eventId))
            .for("update");

          if (!locked) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Event not found.",
            });
          }

          await tx.insert(eventCheckIns).values({
            eventId: locked.id,
            userId: member.id,
            method: "manual",
            pointsEarned: locked.pointsValue,
            actedByUserId: ctx.session.user.id,
          });
          // Honest override: officers may exceed capacity, and the counter
          // still tracks every body in the room.
          await tx
            .update(events)
            .set({ currentCheckIns: locked.currentCheckIns + 1 })
            .where(eq(events.id, locked.id));
        });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
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
    .input(
      z.object({
        eventId: z.string().min(1),
        userId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction(async (tx) => {
        // Same lock order as the capped check-in path: event row first, then
        // the attendance row. Taking them the other way deadlocks under load.
        const [locked] = await tx
          .select({ id: events.id, currentCheckIns: events.currentCheckIns })
          .from(events)
          .where(eq(events.id, input.eventId))
          .for("update");

        if (!locked) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Event not found.",
          });
        }

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

        await tx
          .update(events)
          .set({
            currentCheckIns: Math.max(locked.currentCheckIns - 1, 0),
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

      assertRateLimit(`check-in:${userId}`, CHECK_IN_LIMIT);

      // Lookup outside the transaction — the code index settles "no such
      // event" without taking a row lock. Everything mutable is re-checked
      // inside once the event row is locked.
      const event = await ctx.db.query.events.findFirst({
        where: eq(events.checkInCode, code),
      });

      if (!event) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "That code is not valid.",
        });
      }

      let eventTitle = event.title;
      let pointsEarned = event.pointsValue;

      if (event.maxCheckIns === null) {
        /*
         * Uncapped: no capacity counter to serialise on, but archive / disable /
         * window still have to be re-validated under a lock so a concurrent
         * officer close cannot race the insert.
         *
         * `currentCheckIns` is deliberately NOT incremented here. It exists to
         * settle capacity, this event has none, and a shared counter is a row
         * every writer must serialise on. `listAll` already reports attendance
         * with `count(*)`, and `update` recomputes the counter if a capacity is
         * ever added.
         */
        await ctx.db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(events)
            .where(eq(events.id, event.id))
            .for("update");

          if (locked?.archivedAt != null || !locked?.checkInEnabled) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Check-in is closed for this event.",
            });
          }
          assertCheckInWindow(locked.startsAt);

          eventTitle = locked.title;
          pointsEarned = locked.pointsValue;

          try {
            // pointsEarned is snapshotted here and never recomputed. Re-pricing
            // the event later moves nobody's existing total.
            await tx.insert(eventCheckIns).values({
              eventId: locked.id,
              userId,
              method: "code",
              pointsEarned: locked.pointsValue,
            });
          } catch (error) {
            // The unique constraint is the arbiter of a double tap, not a read
            // that preceded it, and the loser has to read as the same conflict a
            // sequential retry gets rather than an unexplained failure.
            if (isUniqueViolation(error)) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "You are already checked in to this event.",
              });
            }
            throw error;
          }
        });
      } else {
        await ctx.db.transaction(async (tx) => {
          // Capacity is a shared decision, so here the lock is the point: two
          // phones must not both read the last free seat. Correctness beats
          // throughput on the events that have a limit, which are the small
          // ones where a queue costs least.
          const [locked] = await tx
            .select()
            .from(events)
            .where(eq(events.id, event.id))
            .for("update");

          if (locked?.archivedAt != null || !locked?.checkInEnabled) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Check-in is closed for this event.",
            });
          }
          assertCheckInWindow(locked.startsAt);

          eventTitle = locked.title;
          pointsEarned = locked.pointsValue;

          const existing = await tx.query.eventCheckIns.findFirst({
            where: and(
              eq(eventCheckIns.eventId, locked.id),
              eq(eventCheckIns.userId, userId),
            ),
          });

          // Tested before capacity on purpose: somebody already inside is a
          // duplicate, not an extra body, so a member re-tapping at a full
          // event is told they are already in rather than that it is full.
          if (existing) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "You are already checked in to this event.",
            });
          }

          if (
            locked.maxCheckIns !== null &&
            locked.currentCheckIns >= locked.maxCheckIns
          ) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This event is full.",
            });
          }

          try {
            await tx.insert(eventCheckIns).values({
              eventId: locked.id,
              userId,
              method: "code",
              pointsEarned: locked.pointsValue,
            });
          } catch (error) {
            if (isUniqueViolation(error)) {
              throw new TRPCError({
                code: "CONFLICT",
                message: "You are already checked in to this event.",
              });
            }
            throw error;
          }

          // Row is already locked FOR UPDATE; capacity was checked above.
          await tx
            .update(events)
            .set({ currentCheckIns: locked.currentCheckIns + 1 })
            .where(eq(events.id, locked.id));
        });
      }

      // Totals are read after the write commits, never inside it. Running this
      // aggregate inside the transaction meant every other scanner waited on
      // one member's arithmetic.
      const [totals] = await ctx.db
        .select(totalsColumns)
        .from(eventCheckIns)
        .innerJoin(events, eq(events.id, eventCheckIns.eventId))
        .where(
          and(eq(eventCheckIns.userId, userId), isNull(events.archivedAt)),
        );

      return {
        eventTitle,
        pointsEarned,
        totalPoints: asInt(totals?.totalPoints),
        totalEvents: asInt(totals?.totalEvents),
      };
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
      .where(
        and(
          eq(eventCheckIns.userId, ctx.session.user.id),
          isNull(events.archivedAt),
        ),
      )
      .orderBy(desc(eventCheckIns.checkedInAt))
      .limit(100);
  }),

  /** One aggregate row, one index scan. Nothing sums in JavaScript. */
  myStats: protectedProcedure.query(async ({ ctx }) => {
    const [totals] = await ctx.db
      .select(totalsColumns)
      .from(eventCheckIns)
      .innerJoin(events, eq(events.id, eventCheckIns.eventId))
      .where(
        and(
          eq(eventCheckIns.userId, ctx.session.user.id),
          isNull(events.archivedAt),
        ),
      );

    return {
      totalEvents: asInt(totals?.totalEvents),
      totalPoints: asInt(totals?.totalPoints),
      memberSince: asDate(totals?.memberSince),
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
