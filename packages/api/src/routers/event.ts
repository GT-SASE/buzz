import { randomInt } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";

import { asDate, asInt, totalsColumns } from "../aggregates";
import {
  attendanceEvents,
  attendanceFilter,
  attendancePoints,
} from "../attendance";
import { recordAudit, recordPoints } from "../audit";
import { sendCalendarInvite } from "../calendar-invite";
import {
  ALPHABET,
  checkInCodeFor,
  checkInCodeIsCurrent,
  windowEnd,
  WINDOW_MS,
} from "../check-in-code";
import { notFound } from "../errors";
import {
  noNotice,
  notifyEventChange,
  notifyWaitlistPromotion,
  sumNotices,
  type Notice,
} from "../notify";
import { isUndefinedTable, isUniqueViolation } from "../pg-errors";
import { semesterWindow } from "../periods";
import {
  assertRateLimit,
  CHECK_IN_LIMIT,
  EXPORT_ATTENDANCE_LIMIT,
  MANUAL_CHECK_IN_LIMIT,
  REGENERATE_CODE_LIMIT,
  RSVP_LIMIT,
} from "../rate-limit";
import { MAX_OCCURRENCES, occurrenceStarts, shiftLike } from "../series";
import { adminProcedure, createTRPCRouter, protectedProcedure } from "../trpc";
import {
  lockEvent,
  promoteWaitlist,
  rsvpCount,
  seatStates,
  tolerateMissingWaitlist,
  waitlistFor,
  waitlistPlace,
  type Promoted,
  type SeatState,
  type Transaction,
} from "../waitlist";
import {
  EVENT_CADENCES,
  eventCheckIns,
  eventRsvps,
  events,
  eventSeriesMembers,
  eventWaitlist,
  pointsLedger,
  users,
  type db as Db,
  type EventCadence,
} from "@buzz/db";

/**
 * How long after an event starts the door stays open. The member-facing list
 * stops advertising an event past this point, and check-in has to agree — or a
 * photographed code keeps admitting people weeks later.
 */
const CHECK_IN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How early before start members may check in. */
const CHECK_IN_GRACE_MS = 2 * 60 * 60 * 1000;

const TWO_YEARS_MS = 2 * 365.25 * 24 * 60 * 60 * 1000;

const CODE_LENGTH = 8;

function newCheckInCode() {
  let code = "";
  // `randomInt` is uniform; `random % length` would favour the first glyphs.
  while (code.length < CODE_LENGTH)
    code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

/** "  ab-cd ef " -> "ABCDEF". Members retype these, so be forgiving. */
function normalizeCode(input: string) {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The event a submitted code admits to right now, or null. The code is the
 * event's stored key followed by a MAC of the current time window (see
 * check-in-code.ts), so a code that was once right, a poster, or a guess at
 * the key are all the same answer: not valid.
 */
async function eventForCode(db: Pick<typeof Db, "query">, raw: string) {
  const code = normalizeCode(raw);
  if (code.length <= CODE_LENGTH) return null;
  const event = await db.query.events.findFirst({
    where: eq(events.checkInCode, code.slice(0, CODE_LENGTH)),
  });
  return event && checkInCodeIsCurrent(event, code) ? event : null;
}

const CODE_REFUSED =
  "That code is not valid or has expired. Scan the QR code on the screen again.";

function checkInNotYetOpen(startsAt: Date, now: number) {
  return startsAt.getTime() - CHECK_IN_GRACE_MS > now;
}

function checkInClosed(startsAt: Date, now: number) {
  return startsAt.getTime() < now - CHECK_IN_WINDOW_MS;
}

function assertCheckInWindow(startsAt: Date) {
  const now = Date.now();
  if (checkInNotYetOpen(startsAt, now)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check-in has not opened yet.",
    });
  }
  if (checkInClosed(startsAt, now)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Check-in for this event has closed.",
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
  maxCheckIns: events.maxCheckIns,
} as const;

/** Who RSVPed: the members told when an event changes or is cancelled. */
function rsvpRecipients(db: typeof Db, eventId: string) {
  return () =>
    db
      .select({ id: users.id, email: users.email })
      .from(eventRsvps)
      .innerJoin(users, eq(users.id, eventRsvps.userId))
      .where(eq(eventRsvps.eventId, eventId));
}

/** What a member has attended that still counts, newest first. */
function attendedEvents(db: typeof Db, userId: string) {
  return db
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
    .where(and(eq(eventCheckIns.userId, userId), isNull(events.archivedAt)))
    .orderBy(desc(eventCheckIns.checkedInAt))
    .limit(100);
}

function memberTotals(db: typeof Db, userId: string) {
  return db
    .select(totalsColumns)
    .from(eventCheckIns)
    .innerJoin(events, eq(events.id, eventCheckIns.eventId))
    .where(and(eq(eventCheckIns.userId, userId), isNull(events.archivedAt)));
}

/** Events still open to the member, marked with whether they went or RSVPed. */
function upcomingEvents(db: typeof Db, userId: string, cutoff: Date) {
  return db
    .select({
      ...publicEventColumns,
      attendedAt: eventCheckIns.checkedInAt,
      rsvpedAt: eventRsvps.createdAt,
    })
    .from(events)
    .leftJoin(
      eventCheckIns,
      and(
        eq(eventCheckIns.eventId, events.id),
        eq(eventCheckIns.userId, userId),
      ),
    )
    .leftJoin(
      eventRsvps,
      and(eq(eventRsvps.eventId, events.id), eq(eventRsvps.userId, userId)),
    )
    .where(and(isNull(events.archivedAt), gte(events.startsAt, cutoff)))
    .orderBy(asc(events.startsAt))
    .limit(20);
}

const eventInput = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  location: z.string().trim().max(200).optional(),
  startsAt: z.coerce.date().refine((date) => {
    const t = date.getTime();
    const now = Date.now();
    return t >= now - TWO_YEARS_MS && t <= now + TWO_YEARS_MS;
  }, "Event start must be within two years of today."),
  pointsValue: z.number().int().min(0).max(100),
  maxCheckIns: z.number().int().positive().max(10000).nullable().optional(),
});

/**
 * "Repeat weekly for 8 weeks" or "until Dec 10". Either way the series is real
 * event rows created now, never more than MAX_OCCURRENCES of them.
 */
const repeatInput = z
  .object({
    cadence: z.enum(EVENT_CADENCES),
    count: z.number().int().min(2).max(MAX_OCCURRENCES).optional(),
    until: z.coerce.date().optional(),
  })
  .refine(
    (repeat) => (repeat.count === undefined) !== (repeat.until === undefined),
    "Say how many times it repeats, or the date it ends, not both.",
  );

/** One occurrence ("one") or this occurrence and every later one ("future"). */
const scopeInput = z.enum(["one", "future"]).default("one");
type Scope = z.infer<typeof scopeInput>;

const iso = (date: Date) => date.toISOString();

/**
 * The events an edit reaches, locked, in start order. "one" is the event
 * itself. "future" is it plus every later occurrence of its series; an event
 * that is in no series is just itself. The row locks are taken together, in
 * one order, so two officers editing the same series queue rather than
 * deadlock.
 */
async function lockOccurrences(tx: Transaction, eventId: string, scope: Scope) {
  let ids = [eventId];
  if (scope === "future") {
    const [member] = await tx
      .select()
      .from(eventSeriesMembers)
      .where(eq(eventSeriesMembers.eventId, eventId));
    if (member) {
      const later = await tx
        .select({ id: eventSeriesMembers.eventId })
        .from(eventSeriesMembers)
        .where(
          and(
            eq(eventSeriesMembers.seriesId, member.seriesId),
            gte(eventSeriesMembers.position, member.position),
          ),
        );
      ids = later.map((row) => row.id);
    }
  }
  return tx
    .select()
    .from(events)
    .where(inArray(events.id, ids))
    .orderBy(asc(events.startsAt), asc(events.id))
    .for("update");
}

type EventRow = typeof events.$inferSelect;

/** Inserts one event, drawing a fresh code if the one drawn is already taken. */
async function insertEvent(
  tx: Transaction,
  values: Omit<typeof events.$inferInsert, "checkInCode">,
) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [created] = await tx
      .insert(events)
      .values({ ...values, checkInCode: newCheckInCode() })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
  }
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Could not create that event.",
  });
}

/**
 * Which series each event belongs to. A separate read, not a join: a preview
 * that runs this build against a database the migration has not reached yet
 * has no series table, and the officer list must still load (as one-offs).
 */
async function seriesInfo(db: typeof Db, ids: string[]) {
  const info = new Map<
    string,
    { seriesId: string; cadence: EventCadence; position: number }
  >();
  if (ids.length === 0) return info;
  try {
    const rows = await db
      .select()
      .from(eventSeriesMembers)
      .where(inArray(eventSeriesMembers.eventId, ids));
    for (const row of rows) {
      info.set(row.eventId, {
        seriesId: row.seriesId,
        cadence: row.cadence,
        position: row.position,
      });
    }
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
  }
  return info;
}

/** What a member's event list needs to know about seats, from seatStates. */
function seatView(seat: SeatState | undefined, going: boolean) {
  return {
    seatsLeft:
      seat?.seats == null ? null : Math.max(seat.seats - seat.taken, 0),
    waitlistPosition: seat?.waitlistPosition ?? null,
    full: !going && seat?.seats != null && seat.taken >= seat.seats,
  };
}

const seatsOf = (row: { maxCheckIns: number | null }) =>
  row.maxCheckIns ?? "no limit";

export const eventRouter = createTRPCRouter({
  // ---------------------------------------------------------------- officers

  create: adminProcedure
    .input(eventInput.extend({ repeat: repeatInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const { repeat, ...fields } = input;
      const starts = repeat
        ? occurrenceStarts(
            fields.startsAt,
            repeat.cadence,
            repeat.count !== undefined
              ? { count: repeat.count }
              : { until: repeat.until! },
          )
        : [fields.startsAt];
      if (repeat && starts.length < 2) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "That end date leaves only one event. Pick a later date.",
        });
      }

      return ctx.db.transaction(async (tx) => {
        const created: EventRow[] = [];
        for (const startsAt of starts) {
          created.push(
            await insertEvent(tx, {
              ...fields,
              startsAt,
              maxCheckIns: fields.maxCheckIns ?? null,
              createdById: ctx.session.user.id,
            }),
          );
        }
        const first = created[0]!;

        if (repeat) {
          const seriesId = crypto.randomUUID();
          await tx.insert(eventSeriesMembers).values(
            created.map((row, position) => ({
              eventId: row.id,
              seriesId,
              cadence: repeat.cadence,
              position,
            })),
          );
        }

        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: repeat ? "event.create_series" : "event.create",
          targetType: "event",
          targetId: first.id,
          targetLabel: first.title,
          after: {
            startsAt: iso(first.startsAt),
            points: first.pointsValue,
            seats: seatsOf(first),
            ...(repeat
              ? {
                  cadence: repeat.cadence,
                  occurrences: created.length,
                  lastStartsAt: iso(created[created.length - 1]!.startsAt),
                }
              : {}),
          },
        });
        return { ...first, occurrences: created.length };
      });
    }),

  update: adminProcedure
    .input(eventInput.extend({ id: z.string().min(1), scope: scopeInput }))
    .mutation(async ({ ctx, input }) => {
      const { id, scope, ...fields } = input;
      // Editing pointsValue changes what FUTURE attendance is worth. Rows
      // already written keep the value they were stamped with.
      //
      // Every nullable column is coerced to an explicit null, because Drizzle
      // strips `undefined` out of the update set entirely. Without this,
      // clearing an event's location or description silently does nothing: the
      // column is simply absent from the UPDATE, the mutation reports success,
      // and the old text keeps rendering to members.
      const capacity = fields.maxCheckIns ?? null;

      // Everything below runs in one transaction with every affected event
      // locked, so a check-in between the recount and the write cannot leave
      // the counter low, and a cancel racing a capacity change cannot leave a
      // seat empty with someone waiting.
      const updated = await ctx.db.transaction(async (tx) => {
        const locked = await lockOccurrences(tx, id, scope);
        const target = locked.find((row) => row.id === id);
        if (!target) return null;

        const edited = {
          title: fields.title !== target.title,
          description: (fields.description ?? null) !== target.description,
          location: (fields.location ?? null) !== target.location,
          startsAt: fields.startsAt.getTime() !== target.startsAt.getTime(),
          pointsValue: fields.pointsValue !== target.pointsValue,
          maxCheckIns: capacity !== target.maxCheckIns,
        };

        const results: {
          row: EventRow;
          before: EventRow;
          promoted: Promoted[];
        }[] = [];
        for (const current of locked) {
          const isTarget = current.id === id;
          // The edited event takes the whole form. Its later siblings take only
          // what the officer changed, so a location fixed on one week and a
          // title changed for all of them do not undo each other.
          const set = isTarget
            ? {
                ...fields,
                description: fields.description ?? null,
                location: fields.location ?? null,
                maxCheckIns: capacity,
              }
            : {
                ...(edited.title ? { title: fields.title } : {}),
                ...(edited.description
                  ? { description: fields.description ?? null }
                  : {}),
                ...(edited.location
                  ? { location: fields.location ?? null }
                  : {}),
                ...(edited.pointsValue
                  ? { pointsValue: fields.pointsValue }
                  : {}),
                ...(edited.maxCheckIns ? { maxCheckIns: capacity } : {}),
                ...(edited.startsAt
                  ? {
                      startsAt: shiftLike(
                        current.startsAt,
                        target.startsAt,
                        fields.startsAt,
                      ),
                    }
                  : {}),
              };
          if (Object.keys(set).length === 0) continue;

          const nextCapacity =
            "maxCheckIns" in set
              ? (set.maxCheckIns ?? null)
              : current.maxCheckIns;
          // Uncapped check-ins skip the counter entirely, because a shared
          // counter is a row every scanner has to serialise on. So the moment
          // a capacity is added the counter may be stale, and the gate it
          // feeds would admit past the limit. Recomputing it from the rows
          // that actually exist, under the row lock, is what makes the fast
          // path safe to turn back off.
          const [attendance] =
            nextCapacity === null
              ? []
              : await tx
                  .select({ total: count() })
                  .from(eventCheckIns)
                  .where(eq(eventCheckIns.eventId, current.id));

          const [row] = await tx
            .update(events)
            .set({
              ...set,
              ...(nextCapacity === null
                ? {}
                : { currentCheckIns: asInt(attendance?.total) }),
            })
            .where(eq(events.id, current.id))
            .returning();
          if (!row) continue;

          // Seats added: whoever has been waiting longest gets them now.
          const seatsGrew =
            current.maxCheckIns !== null &&
            (row.maxCheckIns === null || row.maxCheckIns > current.maxCheckIns);
          results.push({
            row,
            before: current,
            promoted: seatsGrew
              ? await tolerateMissingWaitlist(tx, [], (sp) =>
                  promoteWaitlist(sp, row),
                )
              : [],
          });
        }

        const mine = results.find((result) => result.row.id === id);
        if (mine) {
          const { row, before } = mine;
          const pairs: [string, unknown, unknown][] = [];
          if (edited.title) pairs.push(["title", before.title, row.title]);
          if (edited.location) {
            pairs.push(["location", before.location, row.location]);
          }
          if (edited.startsAt) {
            pairs.push(["startsAt", iso(before.startsAt), iso(row.startsAt)]);
          }
          if (edited.pointsValue) {
            pairs.push(["points", before.pointsValue, row.pointsValue]);
          }
          if (edited.maxCheckIns) {
            pairs.push(["seats", seatsOf(before), seatsOf(row)]);
          }
          if (edited.description) pairs.push(["description", null, "changed"]);

          if (pairs.length > 0) {
            const series = scope === "future" && results.length > 1;
            await recordAudit(tx, {
              actorId: ctx.session.user.id,
              action: series ? "event.update_series" : "event.update",
              targetType: "event",
              targetId: id,
              targetLabel: row.title,
              before: Object.fromEntries(pairs.map(([k, from]) => [k, from])),
              after: {
                ...Object.fromEntries(pairs.map(([k, , to]) => [k, to])),
                ...(series ? { occurrences: results.length } : {}),
              },
            });
          }
        }
        return results;
      });

      const mine = updated?.find((result) => result.row.id === id);
      if (!updated || !mine) notFound("Event");

      // Members who RSVPed have the old time or place on their calendar.
      // Past events and archived ones are left alone: nobody is planning
      // around them, and a typo fix there should not email the whole list.
      // One Discord post per edit, however many occurrences it moved.
      const now = Date.now();
      const notices: Notice[] = [];
      for (const { row, before } of updated) {
        const moved =
          before.startsAt.getTime() !== row.startsAt.getTime() ||
          before.location !== row.location;
        if (
          !moved ||
          row.archivedAt !== null ||
          row.startsAt.getTime() <= now
        ) {
          continue;
        }
        // After the commit. The calendar invite is the email, so a member is
        // told once, and a failed send never undoes the edit.
        notices.push(
          await notifyEventChange(
            ctx.db,
            row,
            "moved",
            rsvpRecipients(ctx.db, row.id),
            { channel: notices.length === 0 },
          ),
        );
      }
      let promotedCount = 0;
      for (const { row, promoted } of updated) {
        promotedCount += promoted.length;
        await notifyWaitlistPromotion(row, promoted);
      }
      return {
        ...mine.row,
        invites: notices.length > 0 ? sumNotices(notices) : noNotice,
        occurrences: updated.length,
        promoted: promotedCount,
      };
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
      const now = Date.now();
      const cutoff = now - CHECK_IN_WINDOW_MS;
      const series = await seriesInfo(
        ctx.db,
        rows.map((row) => row.id),
      );
      return {
        events: rows.map((row) => {
          const isPast = row.startsAt.getTime() < cutoff;
          // The stored flag is a manual toggle that never flips itself off, so
          // report the effective state: a past event is always closed.
          return {
            ...row,
            series: series.get(row.id) ?? null,
            checkInEnabled: row.checkInEnabled && !isPast,
            isPast,
            // And an event more than two hours out is not open yet either.
            notYetOpen: checkInNotYetOpen(row.startsAt, now),
            opensAt: new Date(row.startsAt.getTime() - CHECK_IN_GRACE_MS),
          };
        }),
        total: asInt(totals?.total),
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
      // All four reads key off `input.id`, so they share one round trip. A
      // missing event just means the other three come back empty and unused.
      const [event, roster, [rosterCount], rsvps, waitlist, series] =
        await Promise.all([
          ctx.db.query.events.findFirst({
            where: eq(events.id, input.id),
          }),
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
            .where(eq(eventCheckIns.eventId, input.id))
            .orderBy(desc(eventCheckIns.checkedInAt))
            .limit(input.limit)
            .offset(input.offset),
          ctx.db
            .select({ total: count() })
            .from(eventCheckIns)
            .where(eq(eventCheckIns.eventId, input.id)),
          ctx.db
            .select({
              userId: eventRsvps.userId,
              name: users.name,
              email: users.email,
              createdAt: eventRsvps.createdAt,
            })
            .from(eventRsvps)
            .innerJoin(users, eq(users.id, eventRsvps.userId))
            .where(eq(eventRsvps.eventId, input.id))
            .orderBy(asc(eventRsvps.createdAt)),
          waitlistFor(ctx.db, input.id),
          seriesInfo(ctx.db, [input.id]),
        ]);

      if (!event) {
        notFound("Event");
      }

      // The officer screen shows whether the door is open. Without this it can
      // only see `checkInEnabled` and would keep advertising a code that
      // `checkIn` has already started refusing on the 24-hour window alone.
      const now = Date.now();
      const isPast = checkInClosed(event.startsAt, now);
      // Same for the other end: an officer can turn check-in on hours early.
      const notYetOpen = checkInNotYetOpen(event.startsAt, now);
      const opensAt = new Date(event.startsAt.getTime() - CHECK_IN_GRACE_MS);

      // The stored key is not a credential on its own any more, but it has no
      // use on an officer screen either: the QR comes from `presentCode`.
      const { checkInCode: _key, ...shown } = event; // eslint-disable-line @typescript-eslint/no-unused-vars
      return {
        event: { ...shown, checkInEnabled: event.checkInEnabled && !isPast },
        series: series.get(input.id) ?? null,
        waitlist,
        roster,
        rosterTotal: asInt(rosterCount?.total),
        isPast,
        notYetOpen,
        opensAt,
        rsvps,
      };
    }),

  /** Full attendance for CSV. Capped so an uncapped event cannot OOM the handler. */
  exportAttendance: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `export-attendance:${ctx.session.user.id}`,
        EXPORT_ATTENDANCE_LIMIT,
      );

      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.id),
        columns: { id: true, title: true },
      });

      if (!event) {
        notFound("Event");
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

      await recordAudit(ctx.db, {
        actorId: ctx.session.user.id,
        action: "export.attendance",
        targetType: "event",
        targetId: event.id,
        targetLabel: event.title,
        after: { rows: rows.length, truncated: rows.length >= 5000 },
      });

      return { rows, truncated: rows.length >= 5000 };
    }),

  setCheckInEnabled: adminProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.enabled) {
        const event = await ctx.db.query.events.findFirst({
          where: eq(events.id, input.id),
          columns: { startsAt: true },
        });
        if (!event) {
          notFound("Event");
        }
        if (checkInClosed(event.startsAt, Date.now())) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message:
              "Check-in closes a day after an event starts. This one has ended.",
          });
        }
      }

      return ctx.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(events)
          .set({ checkInEnabled: input.enabled })
          .where(eq(events.id, input.id))
          .returning({
            id: events.id,
            title: events.title,
            checkInEnabled: events.checkInEnabled,
          });

        if (!updated) {
          notFound("Event");
        }
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "event.set_check_in",
          targetType: "event",
          targetId: updated.id,
          targetLabel: updated.title,
          after: { checkInEnabled: updated.checkInEnabled },
        });
        return { id: updated.id, checkInEnabled: updated.checkInEnabled };
      });
    }),

  /**
   * Archiving an event that has not started is how an officer cancels it, so
   * members who RSVPed are told, and told again if it is restored. A past
   * event, or one already in the state asked for, tells nobody.
   */
  setArchived: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        archived: z.boolean(),
        scope: scopeInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await ctx.db.transaction(async (tx) => {
        const locked = await lockOccurrences(tx, input.id, input.scope);
        const target = locked.find((row) => row.id === input.id);
        if (!target) return null;

        const changes: { row: EventRow }[] = [];
        for (const current of locked) {
          // Already in the state asked for: nothing to write, nobody to tell.
          if ((current.archivedAt !== null) === input.archived) continue;
          const [row] = await tx
            .update(events)
            .set({ archivedAt: input.archived ? new Date() : null })
            .where(eq(events.id, current.id))
            .returning();
          if (row) changes.push({ row });
        }

        if (changes.length > 0) {
          const series = input.scope === "future" && changes.length > 1;
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: series ? "event.archive_series" : "event.archive",
            targetType: "event",
            targetId: target.id,
            targetLabel: target.title,
            after: {
              archived: input.archived,
              ...(series ? { occurrences: changes.length } : {}),
            },
          });
        }
        return {
          row:
            changes.find((change) => change.row.id === input.id)?.row ?? target,
          changes,
        };
      });

      if (!result) {
        notFound("Event");
      }
      const { row, changes } = result;
      const now = Date.now();
      const notices: Notice[] = [];
      for (const change of changes) {
        if (change.row.startsAt.getTime() <= now) continue;
        notices.push(
          await notifyEventChange(
            ctx.db,
            change.row,
            input.archived ? "cancelled" : "restored",
            rsvpRecipients(ctx.db, change.row.id),
            { channel: notices.length === 0 },
          ),
        );
      }
      return {
        id: row.id,
        archivedAt: row.archivedAt,
        occurrences: changes.length,
        invites: notices.length > 0 ? sumNotices(notices) : noNotice,
      };
    }),

  /** Revocation: rotating the code kills a photographed poster immediately. */
  regenerateCode: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `regenerate-code:${ctx.session.user.id}`,
        REGENERATE_CODE_LIMIT,
      );

      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await ctx.db.transaction(async (tx) => {
            const [updated] = await tx
              .update(events)
              .set({ checkInCode: newCheckInCode() })
              .where(eq(events.id, input.id))
              .returning({ id: events.id, title: events.title });

            if (!updated) {
              notFound("Event");
            }
            await recordAudit(tx, {
              actorId: ctx.session.user.id,
              action: "event.revoke_codes",
              targetType: "event",
              targetId: updated.id,
              targetLabel: updated.title,
            });
            return { id: updated.id };
          });
        } catch (error) {
          if (error instanceof TRPCError || !isUniqueViolation(error)) {
            throw error;
          }
        }
      }

      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Could not revoke that code.",
      });
    }),

  /**
   * The code to show on the projector right now, and when it changes. The
   * screen asks again at `windowEndsAt`; `serverNow` lets it correct for a
   * wrong clock on the laptop driving the projector.
   */
  presentCode: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const event = await ctx.db.query.events.findFirst({
        where: eq(events.id, input.id),
        columns: { id: true, checkInCode: true },
      });
      if (!event) {
        notFound("Event");
      }
      const now = Date.now();
      return {
        code: checkInCodeFor(event, now),
        windowEndsAt: windowEnd(now),
        windowMs: WINDOW_MS,
        serverNow: now,
      };
    }),

  /** For the member whose phone died. Same snapshot rule as the code path. */
  manualCheckIn: adminProcedure
    .input(z.object({ eventId: z.string().min(1), email: z.string().email() }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
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

      // Officers scan like everyone else; this path is for someone else's phone.
      if (member.id === ctx.session.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Scan the QR to check yourself in.",
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
            notFound("Event");
          }

          if (locked.archivedAt != null) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "Restore this event before adding check-ins.",
            });
          }

          await tx.insert(eventCheckIns).values({
            eventId: locked.id,
            userId: member.id,
            method: "manual",
            pointsEarned: locked.pointsValue,
            actedByUserId: ctx.session.user.id,
          });
          await recordPoints(tx, [
            {
              userId: member.id,
              delta: locked.pointsValue,
              reason: `Checked in by an officer: ${locked.title}`,
              source: "manual_check_in",
              eventId: locked.id,
              actedByUserId: ctx.session.user.id,
            },
          ]);
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "event.manual_check_in",
            targetType: "member",
            targetId: member.id,
            targetLabel: member.email,
            after: {
              eventId: locked.id,
              event: locked.title,
              points: locked.pointsValue,
            },
          });
          // Officers may exceed capacity, and a capped event's counter still
          // tracks every body in the room. An uncapped event has no counter to
          // keep: the code path skips it, so this one does too.
          if (locked.maxCheckIns !== null) {
            await tx
              .update(events)
              .set({ currentCheckIns: locked.currentCheckIns + 1 })
              .where(eq(events.id, locked.id));
          }
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
          .select({
            id: events.id,
            title: events.title,
            currentCheckIns: events.currentCheckIns,
            maxCheckIns: events.maxCheckIns,
          })
          .from(events)
          .where(eq(events.id, input.eventId))
          .for("update");

        if (!locked) {
          notFound("Event");
        }

        const removed = await tx
          .delete(eventCheckIns)
          .where(
            and(
              eq(eventCheckIns.eventId, input.eventId),
              eq(eventCheckIns.userId, input.userId),
            ),
          )
          .returning({
            id: eventCheckIns.id,
            pointsEarned: eventCheckIns.pointsEarned,
            method: eventCheckIns.method,
          });

        const [gone] = removed;
        if (!gone) return;

        const [member] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, input.userId));

        // The ledger takes the grant back with a row of its own: it is
        // append-only, so the earlier grant stays and the pair nets to zero.
        await recordPoints(tx, [
          {
            userId: input.userId,
            delta: 0 - gone.pointsEarned,
            reason: `Check-in removed: ${locked.title}`,
            source: "check_in_removed",
            eventId: locked.id,
            actedByUserId: ctx.session.user.id,
          },
        ]);
        await recordAudit(tx, {
          actorId: ctx.session.user.id,
          action: "event.remove_check_in",
          targetType: "member",
          targetId: input.userId,
          targetLabel: member?.email ?? null,
          before: {
            eventId: locked.id,
            event: locked.title,
            method: gone.method,
            points: gone.pointsEarned,
          },
        });

        // Only a capped event keeps a counter (see manualCheckIn).
        if (locked.maxCheckIns === null) return;

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
    .input(z.object({ code: z.string().min(4).max(32) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      await assertRateLimit(ctx.db, `check-in:${userId}`, CHECK_IN_LIMIT);

      // Lookup outside the transaction — the code index settles "no such
      // event" without taking a row lock. Everything mutable is re-checked
      // inside once the event row is locked.
      const event = await eventForCode(ctx.db, input.code);

      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: CODE_REFUSED });
      }

      let eventTitle = event.title;
      let pointsEarned = event.pointsValue;

      /*
       * One transaction for both kinds of event, because which kind this is has
       * to be read off the locked row. The lookup above is unlocked, and an
       * officer can add or drop a capacity between it and the lock. A scan that
       * took the uncapped path for an event that is now capped would be
       * admitted without being counted or checked against the limit, leaving
       * `currentCheckIns` low for the life of the event.
       *
       * The lock is taken either way: archive / disable / window have to be
       * re-validated under it so a concurrent officer close cannot race the
       * insert.
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

        // `currentCheckIns` is capacity bookkeeping. An uncapped event never
        // reads or writes it: no counter row for every scanner to update,
        // `listAll` reports attendance with `count(*)`, and `update` recomputes
        // the counter if a capacity is ever added.
        const { maxCheckIns } = locked;

        if (maxCheckIns !== null) {
          // Capacity is a shared decision, so here the lock is the point: two
          // phones must not both read the last free seat. Correctness beats
          // throughput on the events that have a limit, which are the small
          // ones where a queue costs least.
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

          if (locked.currentCheckIns >= maxCheckIns) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "This event is full.",
            });
          }
        }

        try {
          // pointsEarned is snapshotted here and never recomputed. Re-pricing
          // the event later moves nobody's existing total.
          await tx.insert(eventCheckIns).values({
            eventId: locked.id,
            userId,
            method: "code",
            pointsEarned,
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

        // Same transaction as the check-in, so the ledger and the attendance
        // row cannot disagree about whether this scan happened.
        await recordPoints(tx, [
          {
            userId,
            delta: pointsEarned,
            reason: `Checked in: ${locked.title}`,
            source: "check_in",
            eventId: locked.id,
          },
        ]);

        if (maxCheckIns !== null) {
          // Row is already locked FOR UPDATE; capacity was checked above.
          await tx
            .update(events)
            .set({ currentCheckIns: locked.currentCheckIns + 1 })
            .where(eq(events.id, locked.id));
        }
      });

      // Totals are read after the write commits, never inside it. Running this
      // aggregate inside the transaction meant every other scanner waited on
      // one member's arithmetic.
      const [totals] = await memberTotals(ctx.db, userId);

      return {
        eventTitle,
        pointsEarned,
        totalPoints: asInt(totals?.totalPoints),
        totalEvents: asInt(totals?.totalEvents),
      };
    }),

  /** Everything this person has been to that still counts (archived events left out). One join, points already snapshotted. */
  myEvents: protectedProcedure.query(async ({ ctx }) => {
    return attendedEvents(ctx.db, ctx.session.user.id);
  }),

  /** One aggregate row, one index scan. Nothing sums in JavaScript. */
  myStats: protectedProcedure.query(async ({ ctx }) => {
    const [totals] = await memberTotals(ctx.db, ctx.session.user.id);

    return {
      totalEvents: asInt(totals?.totalEvents),
      totalPoints: asInt(totals?.totalPoints),
      memberSince: asDate(totals?.memberSince),
    };
  }),

  /**
   * Say you plan to come. Only before the event starts; repeats are no-ops.
   * An event with seats takes RSVPs until they are gone, then a waitlist. The
   * count, the insert and the choice between the two happen under the event
   * row lock, so two members taking the last seat cannot both get it.
   */
  rsvp: protectedProcedure
    .input(z.object({ eventId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(ctx.db, `rsvp:${ctx.session.user.id}`, RSVP_LIMIT);
      const userId = ctx.session.user.id;

      const outcome = await ctx.db.transaction(async (tx) => {
        const [event] = await lockEvent(tx, input.eventId);
        if (!event || event.archivedAt) notFound("Event");
        if (event.startsAt.getTime() <= Date.now()) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "This event has already started.",
          });
        }

        const [going] = await tx
          .select({ userId: eventRsvps.userId })
          .from(eventRsvps)
          .where(
            and(
              eq(eventRsvps.eventId, event.id),
              eq(eventRsvps.userId, userId),
            ),
          );
        if (going) return { event, status: "going" as const, added: false };

        if (
          event.maxCheckIns !== null &&
          (await rsvpCount(tx, event.id)) >= event.maxCheckIns
        ) {
          // No waitlist table yet (a preview ahead of its migration) means no
          // waitlist: the member is seated as before.
          const position = await tolerateMissingWaitlist(
            tx,
            null,
            async (sp) => {
              await sp
                .insert(eventWaitlist)
                .values({ eventId: event.id, userId })
                .onConflictDoNothing();
              const [mine] = await sp
                .select({ joinedAt: eventWaitlist.createdAt })
                .from(eventWaitlist)
                .where(
                  and(
                    eq(eventWaitlist.eventId, event.id),
                    eq(eventWaitlist.userId, userId),
                  ),
                );
              return waitlistPlace(sp, event.id, mine?.joinedAt ?? new Date());
            },
          );
          if (position !== null) {
            return {
              event,
              status: "waitlisted" as const,
              added: false,
              position,
            };
          }
        }

        const [added] = await tx
          .insert(eventRsvps)
          .values({ eventId: event.id, userId })
          .onConflictDoNothing()
          .returning({ eventId: eventRsvps.eventId });
        return { event, status: "going" as const, added: Boolean(added) };
      });

      if (outcome.status === "waitlisted") {
        return {
          eventId: outcome.event.id,
          rsvped: false,
          waitlisted: true,
          waitlistPosition: outcome.position,
          invited: false,
        };
      }
      const email = ctx.session.user.email;
      const invited =
        outcome.added && email
          ? await sendCalendarInvite("REQUEST", outcome.event, email)
          : false;
      return {
        eventId: outcome.event.id,
        rsvped: true,
        waitlisted: false,
        waitlistPosition: null,
        invited,
      };
    }),

  /**
   * Leave: give up the seat, or the place in line. A freed seat goes to the
   * first member on the waitlist inside the same transaction, who is told
   * after it commits.
   */
  cancelRsvp: protectedProcedure
    .input(z.object({ eventId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await assertRateLimit(ctx.db, `rsvp:${ctx.session.user.id}`, RSVP_LIMIT);
      const userId = ctx.session.user.id;

      const result = await ctx.db.transaction(async (tx) => {
        const [event] = await lockEvent(tx, input.eventId);
        if (!event) return null;

        const [removed] = await tx
          .delete(eventRsvps)
          .where(
            and(
              eq(eventRsvps.eventId, event.id),
              eq(eventRsvps.userId, userId),
            ),
          )
          .returning({ eventId: eventRsvps.eventId });
        // An uncapped event never has a waitlist, so there is nothing more
        // to do for it.
        if (event.maxCheckIns === null && !removed) {
          return { event, removed: false, promoted: [] as Promoted[] };
        }
        const promoted = await tolerateMissingWaitlist(
          tx,
          [] as Promoted[],
          async (sp) => {
            await sp
              .delete(eventWaitlist)
              .where(
                and(
                  eq(eventWaitlist.eventId, event.id),
                  eq(eventWaitlist.userId, userId),
                ),
              );
            return removed ? await promoteWaitlist(sp, event) : [];
          },
        );
        return { event, removed: Boolean(removed), promoted };
      });

      const email = ctx.session.user.email;
      const uninvited =
        result?.removed && email
          ? await sendCalendarInvite("CANCEL", result.event, email)
          : false;
      if (result) await notifyWaitlistPromotion(result.event, result.promoted);
      return { eventId: input.eventId, rsvped: false, uninvited };
    }),

  /**
   * Which of these events this member has RSVPed to. The public event pages
   * are static, so they ask after paint instead of reading the session.
   */
  myRsvps: protectedProcedure
    .input(z.object({ eventIds: z.array(z.string().min(1).max(255)).max(100) }))
    .query(async ({ ctx, input }) => {
      if (input.eventIds.length === 0) return [];
      const rows = await ctx.db
        .select({ eventId: eventRsvps.eventId })
        .from(eventRsvps)
        .where(
          and(
            eq(eventRsvps.userId, ctx.session.user.id),
            inArray(eventRsvps.eventId, input.eventIds),
          ),
        );
      return rows.map((row) => row.eventId);
    }),

  /**
   * What the public pages need to draw an RSVP button for each event: which
   * ones the member is going to, which ones they are waiting on (and their
   * place in line), and which are full. The pages are static, so they ask
   * after paint.
   */
  rsvpState: protectedProcedure
    .input(z.object({ eventIds: z.array(z.string().min(1).max(255)).max(100) }))
    .query(async ({ ctx, input }) => {
      const empty = {
        going: [] as string[],
        waitlisted: [] as { eventId: string; position: number }[],
        full: [] as string[],
      };
      if (input.eventIds.length === 0) return empty;
      const userId = ctx.session.user.id;
      const [going, seats] = await Promise.all([
        ctx.db
          .select({ eventId: eventRsvps.eventId })
          .from(eventRsvps)
          .where(
            and(
              eq(eventRsvps.userId, userId),
              inArray(eventRsvps.eventId, input.eventIds),
            ),
          ),
        seatStates(ctx.db, userId, input.eventIds),
      ]);
      const mine = new Set(going.map((row) => row.eventId));
      const waitlisted: { eventId: string; position: number }[] = [];
      const full: string[] = [];
      for (const [eventId, seat] of seats) {
        if (seat.waitlistPosition !== null) {
          waitlisted.push({ eventId, position: seat.waitlistPosition });
        } else if (
          seat.seats !== null &&
          seat.taken >= seat.seats &&
          !mine.has(eventId)
        ) {
          full.push(eventId);
        }
      }
      return { going: [...mine], waitlisted, full };
    }),

  /** What is still open, marked with whether this member has been or RSVPed. */
  upcoming: protectedProcedure.query(async ({ ctx }) => {
    const now = Date.now();
    const cutoff = new Date(now - CHECK_IN_WINDOW_MS);

    const rows = await upcomingEvents(ctx.db, ctx.session.user.id, cutoff);
    const seats = await seatStates(
      ctx.db,
      ctx.session.user.id,
      rows.map((row) => row.id),
    );
    // RSVPs close at the start time; the list keeps an event a day longer.
    return rows.map((row) => ({
      ...row,
      ...seatView(seats.get(row.id), row.rsvpedAt !== null),
      rsvpOpen: row.startsAt.getTime() > now,
      checkInOpen:
        row.checkInEnabled &&
        !checkInNotYetOpen(row.startsAt, now) &&
        !checkInClosed(row.startsAt, now),
    }));
  }),

  /**
   * Read-only look at the event a scanned code belongs to, so the confirm
   * screen can name it before anyone commits. No side effects. Rate limited
   * so it cannot be used to guess codes.
   */
  peek: protectedProcedure
    .input(z.object({ code: z.string().min(4).max(32) }))
    .query(async ({ ctx, input }) => {
      await assertRateLimit(
        ctx.db,
        `check-in-peek:${ctx.session.user.id}`,
        CHECK_IN_LIMIT,
      );
      const event = await eventForCode(ctx.db, input.code);
      if (!event) return null;
      const now = Date.now();
      return {
        title: event.title,
        startsAt: event.startsAt,
        location: event.location,
        pointsValue: event.pointsValue,
        checkInOpen:
          event.archivedAt == null &&
          event.checkInEnabled &&
          !checkInNotYetOpen(event.startsAt, now) &&
          !checkInClosed(event.startsAt, now),
      };
    }),

  /**
   * The member home screen. One procedure so the three reads share a pool
   * checkout burst instead of three separate tRPC round-trips.
   */
  home: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const cutoff = new Date(Date.now() - CHECK_IN_WINDOW_MS);

    const [attended, totals, thisSemester, upcoming] = await Promise.all([
      attendedEvents(ctx.db, userId),
      memberTotals(ctx.db, userId),
      // Same ledger definition as the leaderboard, so the card and the board
      // always agree on this semester.
      ctx.db
        .select({ points: attendancePoints, events: attendanceEvents })
        .from(pointsLedger)
        .innerJoin(events, eq(events.id, pointsLedger.eventId))
        .where(
          and(
            eq(pointsLedger.userId, userId),
            attendanceFilter(semesterWindow(new Date())),
          ),
        ),
      upcomingEvents(ctx.db, userId, cutoff),
    ]);

    const [row] = totals;
    const now = Date.now();
    const seats = await seatStates(
      ctx.db,
      userId,
      upcoming.map((event) => event.id),
    );
    return {
      attended,
      // `checkInOpen` is what `checkIn` will accept right now: an officer can
      // turn check-in on hours before the window opens.
      upcoming: upcoming.map((event) => ({
        ...event,
        ...seatView(seats.get(event.id), event.rsvpedAt !== null),
        checkInOpen:
          event.checkInEnabled &&
          !checkInNotYetOpen(event.startsAt, now) &&
          !checkInClosed(event.startsAt, now),
      })),
      stats: {
        totalEvents: asInt(row?.totalEvents),
        totalPoints: asInt(row?.totalPoints),
        memberSince: asDate(row?.memberSince),
        /** What the card shows: this semester only, from the ledger. */
        semester: {
          totalPoints: asInt(thisSemester[0]?.points),
          totalEvents: asInt(thisSemester[0]?.events),
        },
      },
    };
  }),
});
