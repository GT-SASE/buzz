import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `packages/api/src/trpc.ts` imports the auth package at module load, and
 * next-auth reaches for `next/server`, which does not resolve outside the Next
 * bundler. Nothing under test is stubbed by this: every context below is
 * hand-built, so no procedure ever calls `auth()`.
 */
vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { and, eq } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");
const { createCaller } = await import("../packages/api/src/root");
const { db, eventCheckIns, events, users } =
  await import("../packages/db/src/index");

/**
 * A whole room checking in at once.
 *
 * A door that works for one person and falls over for thirty is not a door.
 * These tests fire a real burst of concurrent check-ins against the real
 * database and assert both correctness (exactly one row each, totals right)
 * and throughput, because the two are in tension: the safest possible
 * implementation serialises everybody behind one row lock.
 */
const HAS_DB = Boolean(process.env.DATABASE_URL);
const ROOM = 30;

/** Marks every row this file creates so cleanup can find them all. */
const TAG = `loadtest-${randomUUID().slice(0, 8)}`;

const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const code = () =>
  Array.from(
    { length: 8 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)],
  ).join("");

function callerFor(userId: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  return createCaller({
    db,
    headers: new Headers(),
    session: {
      user: { id: userId, role, name: TAG, email: `${userId}@example.invalid` },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
}

describe.skipIf(!HAS_DB)("a room scanning at once", () => {
  const memberIds: string[] = [];
  const eventIds: string[] = [];
  let officerId = "";

  beforeAll(async () => {
    const [officer] = await db
      .insert(users)
      .values({
        email: `${TAG}-officer@example.invalid`,
        name: `${TAG} officer`,
        role: "ADMIN",
      })
      .returning({ id: users.id });
    officerId = officer!.id;

    const rows = await db
      .insert(users)
      .values(
        Array.from({ length: ROOM }, (_, i) => ({
          email: `${TAG}-m${i}@example.invalid`,
          name: `${TAG} member ${i}`,
          role: "MEMBER" as const,
        })),
      )
      .returning({ id: users.id });
    memberIds.push(...rows.map((r) => r.id));
  }, 60_000);

  afterAll(async () => {
    for (const id of eventIds) {
      await db.delete(eventCheckIns).where(eq(eventCheckIns.eventId, id));
      await db.delete(events).where(eq(events.id, id));
    }
    for (const id of [...memberIds, officerId].filter(Boolean)) {
      await db.delete(eventCheckIns).where(eq(eventCheckIns.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  }, 60_000);

  async function makeEvent(maxCheckIns: number | null) {
    const checkInCode = code();
    const [row] = await db
      .insert(events)
      .values({
        title: `${TAG} event`,
        startsAt: new Date(Date.now() + 3_600_000),
        pointsValue: 7,
        checkInCode,
        maxCheckIns,
        createdById: officerId,
      })
      .returning({ id: events.id });
    eventIds.push(row!.id);
    return { id: row!.id, checkInCode };
  }

  it(`admits ${ROOM} simultaneous scans on an uncapped event, exactly once each`, async () => {
    const event = await makeEvent(null);

    const started = Date.now();
    const results = await Promise.allSettled(
      memberIds.map((id) =>
        callerFor(id).event.checkIn({ code: event.checkInCode }),
      ),
    );
    const elapsed = Date.now() - started;

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    // Every scan must succeed: the event is uncapped and each member is
    // distinct, so there is no legitimate reason to turn anyone away.
    expect(failed).toHaveLength(0);
    expect(ok).toHaveLength(ROOM);

    const rows = await db
      .select({ id: eventCheckIns.id })
      .from(eventCheckIns)
      .where(eq(eventCheckIns.eventId, event.id));
    expect(rows).toHaveLength(ROOM);

    // The counter is deliberately NOT maintained on an uncapped event: it
    // exists to settle capacity, and a shared counter would reintroduce the
    // very serialisation this path removes. Attendance is counted from the
    // rows, which the assertion above already checks.
    const [after] = await db
      .select({ currentCheckIns: events.currentCheckIns })
      .from(events)
      .where(eq(events.id, event.id));
    expect(after?.currentCheckIns).toBe(0);

    // Throughput, recorded rather than asserted tightly: this runs against a
    // remote Neon instance from a laptop, so the absolute number is mostly
    // network. Written to a file because a test runner swallows stdout, and
    // the point is to be able to compare the number across a change — a
    // regression into serial execution shows up as a multiple, not a few
    // percent.
    writeFileSync(
      resolve(import.meta.dirname, "../.bench-check-in.json"),
      JSON.stringify(
        { room: ROOM, elapsedMs: elapsed, perScanMs: elapsed / ROOM },
        null,
        2,
      ),
    );
    expect(elapsed).toBeLessThan(30_000);
  }, 120_000);

  it("never oversells a capped event under a simultaneous rush", async () => {
    const seats = 5;
    const event = await makeEvent(seats);

    const results = await Promise.allSettled(
      memberIds.map((id) =>
        callerFor(id).event.checkIn({ code: event.checkInCode }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(seats);

    const rows = await db
      .select({ id: eventCheckIns.id })
      .from(eventCheckIns)
      .where(eq(eventCheckIns.eventId, event.id));
    expect(rows).toHaveLength(seats);

    const [after] = await db
      .select({ currentCheckIns: events.currentCheckIns })
      .from(events)
      .where(eq(events.id, event.id));
    expect(after?.currentCheckIns).toBe(seats);
  }, 120_000);

  it("credits every member exactly the event's points, under load", async () => {
    const event = await makeEvent(null);

    await Promise.all(
      memberIds.map((id) =>
        callerFor(id).event.checkIn({ code: event.checkInCode }),
      ),
    );

    const rows = await db
      .select({ pointsEarned: eventCheckIns.pointsEarned })
      .from(eventCheckIns)
      .where(eq(eventCheckIns.eventId, event.id));

    expect(rows).toHaveLength(ROOM);
    expect(rows.every((r) => r.pointsEarned === 7)).toBe(true);
  }, 120_000);

  it("counts one row when the same member's phone fires repeatedly", async () => {
    const event = await makeEvent(null);
    const member = memberIds[0]!;

    // A jittery scanner can fire the same code several times before the
    // first response lands.
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        callerFor(member).event.checkIn({ code: event.checkInCode }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const rows = await db
      .select({ id: eventCheckIns.id })
      .from(eventCheckIns)
      .where(
        and(
          eq(eventCheckIns.eventId, event.id),
          eq(eventCheckIns.userId, member),
        ),
      );
    expect(rows).toHaveLength(1);

    // Uncapped, so the counter stays at its default; the row count is the
    // thing that must be exactly one.
    const [after] = await db
      .select({ currentCheckIns: events.currentCheckIns })
      .from(events)
      .where(eq(events.id, event.id));
    expect(after?.currentCheckIns).toBe(0);
  }, 120_000);
});
