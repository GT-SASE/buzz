import { and, asc, count, eq, inArray, lte } from "drizzle-orm";

import { isUndefinedTable } from "./pg-errors";
import {
  eventRsvps,
  events,
  eventWaitlist,
  users,
  type db as Db,
} from "@buzz/db";

/**
 * Capacity and the waitlist.
 *
 * One rule keeps every path race-safe: any code that adds or removes an RSVP,
 * joins or leaves the waitlist, or changes the seat count takes `FOR UPDATE`
 * on the event row first (`lockEvent`) and does all of it in that one
 * transaction. Two cancels, a cancel against a new RSVP, and a capacity change
 * therefore queue behind each other and each sees the others' result, so a
 * seat is never given to two people and never left empty with someone waiting.
 *
 * Seats are `event.maxCheckIns`, the same number the door uses: an event that
 * is "limited" to 40 takes 40 RSVPs and then a waitlist.
 */

type Transaction = Parameters<Parameters<typeof Db.transaction>[0]>[0];
type Reader = Pick<typeof Db, "select">;

export type Promoted = { id: string; email: string };

export function lockEvent(tx: Transaction, eventId: string) {
  return tx
    .select({
      id: events.id,
      title: events.title,
      description: events.description,
      location: events.location,
      startsAt: events.startsAt,
      archivedAt: events.archivedAt,
      maxCheckIns: events.maxCheckIns,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .for("update");
}

async function rsvpCount(tx: Transaction, eventId: string) {
  const [row] = await tx
    .select({ total: count() })
    .from(eventRsvps)
    .where(eq(eventRsvps.eventId, eventId));
  return Number(row?.total ?? 0);
}

/**
 * Moves waitlisted members onto free seats, first in line first. Call with the
 * event row locked, after whatever freed a seat. Returns who was promoted so
 * the caller can tell them once the transaction has committed. Nothing moves
 * for an archived event or one that has started: nobody can RSVP then, so a
 * waiting member would be given a seat to an event that is over.
 */
export async function promoteWaitlist(
  tx: Transaction,
  event: {
    id: string;
    maxCheckIns: number | null;
    archivedAt: Date | null;
    startsAt: Date;
  },
  now: number = Date.now(),
): Promise<Promoted[]> {
  if (event.archivedAt !== null || event.startsAt.getTime() <= now) return [];

  let free: number;
  if (event.maxCheckIns === null) {
    // The cap was lifted: everyone waiting gets in.
    free = Number.MAX_SAFE_INTEGER;
  } else {
    free = event.maxCheckIns - (await rsvpCount(tx, event.id));
  }
  if (free <= 0) return [];

  const next = await tx
    .select({
      id: eventWaitlist.userId,
      email: users.email,
      joinedAt: eventWaitlist.createdAt,
    })
    .from(eventWaitlist)
    .innerJoin(users, eq(users.id, eventWaitlist.userId))
    .where(eq(eventWaitlist.eventId, event.id))
    .orderBy(asc(eventWaitlist.createdAt), asc(eventWaitlist.userId))
    .limit(Math.min(free, 1000));
  if (next.length === 0) return [];

  const ids = next.map((member) => member.id);
  await tx
    .delete(eventWaitlist)
    .where(
      and(
        eq(eventWaitlist.eventId, event.id),
        inArray(eventWaitlist.userId, ids),
      ),
    );
  await tx
    .insert(eventRsvps)
    .values(ids.map((userId) => ({ eventId: event.id, userId })))
    .onConflictDoNothing();
  return next.map(({ id, email }) => ({ id, email }));
}

/**
 * Where this member stands, for the events asked about: how many seats, how
 * many taken, and their place in the line (1 is next). Read outside any
 * transaction, for display only; the RSVP mutation decides for itself. A
 * deployment whose migration has not run has no waitlist, so nobody is on one.
 */
export type SeatState = {
  seats: number | null;
  taken: number;
  waitlistPosition: number | null;
};

export async function seatStates(
  db: Reader,
  userId: string,
  eventIds: string[],
): Promise<Map<string, SeatState>> {
  const states = new Map<string, SeatState>();
  if (eventIds.length === 0) return states;

  const capped = await db
    .select({ id: events.id, seats: events.maxCheckIns })
    .from(events)
    .where(inArray(events.id, eventIds));
  const withSeats = capped.filter((row) => row.seats !== null);
  for (const row of capped) {
    states.set(row.id, {
      seats: row.seats,
      taken: 0,
      waitlistPosition: null,
    });
  }
  if (withSeats.length === 0) return states;

  const ids = withSeats.map((row) => row.id);
  const taken = await db
    .select({ eventId: eventRsvps.eventId, total: count() })
    .from(eventRsvps)
    .where(inArray(eventRsvps.eventId, ids))
    .groupBy(eventRsvps.eventId);
  for (const row of taken) {
    const state = states.get(row.eventId);
    if (state) state.taken = Number(row.total);
  }

  try {
    const mine = await db
      .select({
        eventId: eventWaitlist.eventId,
        joinedAt: eventWaitlist.createdAt,
      })
      .from(eventWaitlist)
      .where(
        and(
          eq(eventWaitlist.userId, userId),
          inArray(eventWaitlist.eventId, ids),
        ),
      );
    await Promise.all(
      mine.map(async (row) => {
        const [ahead] = await db
          .select({ total: count() })
          .from(eventWaitlist)
          .where(
            and(
              eq(eventWaitlist.eventId, row.eventId),
              lte(eventWaitlist.createdAt, row.joinedAt),
            ),
          );
        const state = states.get(row.eventId);
        if (state)
          state.waitlistPosition = Math.max(Number(ahead?.total ?? 1), 1);
      }),
    );
  } catch (error) {
    if (!isUndefinedTable(error)) throw error;
  }
  return states;
}

/** Who is waiting, in line order, for the officer's roster. */
export async function waitlistFor(db: Reader, eventId: string) {
  try {
    return await db
      .select({
        userId: eventWaitlist.userId,
        name: users.name,
        email: users.email,
        createdAt: eventWaitlist.createdAt,
      })
      .from(eventWaitlist)
      .innerJoin(users, eq(users.id, eventWaitlist.userId))
      .where(eq(eventWaitlist.eventId, eventId))
      .orderBy(asc(eventWaitlist.createdAt), asc(eventWaitlist.userId));
  } catch (error) {
    if (isUndefinedTable(error)) return [];
    throw error;
  }
}
