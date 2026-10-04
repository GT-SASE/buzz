import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same harness as check-in.integration.test.ts: stub next-auth, import by path.
vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, eventCheckIns, eventRsvps, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 30_000;
const HOUR_MS = 60 * 60 * 1000;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function randomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % 30]).join("");
}

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

function callerFor(user: TestUser) {
  return createCaller({
    db,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: "vitest" },
      expires: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("chapter.turnout", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const id = { first: "", second: "", upcoming: "" };
  let admin: TestUser;

  async function makeUser(tag: string, role: "MEMBER" | "ADMIN") {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-turnout-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag}`,
        role,
      })
      .returning();
    if (!row) throw new Error(`could not create the ${tag} test user`);
    userIds.push(row.id);
    return { id: row.id, email: row.email, role } satisfies TestUser;
  }

  beforeAll(async () => {
    admin = await makeUser("officer", "ADMIN");
    const alex = await makeUser("alex", "MEMBER");
    const sam = await makeUser("sam", "MEMBER");
    const now = Date.now();
    const rows = await db
      .insert(events)
      .values([
        {
          title: "vitest turnout first",
          startsAt: new Date(now - 72 * HOUR_MS),
          checkInCode: randomCode(),
          createdById: admin.id,
        },
        {
          title: "vitest turnout second",
          startsAt: new Date(now - 24 * HOUR_MS),
          checkInCode: randomCode(),
          createdById: admin.id,
        },
        {
          title: "vitest turnout upcoming",
          startsAt: new Date(now + 48 * HOUR_MS),
          checkInCode: randomCode(),
          createdById: admin.id,
        },
      ])
      .returning({ id: events.id, title: events.title });
    for (const row of rows) {
      eventIds.push(row.id);
      if (row.title.endsWith("first")) id.first = row.id;
      if (row.title.endsWith("second")) id.second = row.id;
      if (row.title.endsWith("upcoming")) id.upcoming = row.id;
    }

    // Alex comes to both; Sam only to the second. So the second event has one
    // returning member and one first-timer.
    await db.insert(eventCheckIns).values([
      {
        eventId: id.first,
        userId: alex.id,
        pointsEarned: 10,
        checkedInAt: new Date(now - 72 * HOUR_MS),
      },
      {
        eventId: id.second,
        userId: alex.id,
        pointsEarned: 10,
        checkedInAt: new Date(now - 24 * HOUR_MS),
      },
      {
        eventId: id.second,
        userId: sam.id,
        pointsEarned: 10,
        checkedInAt: new Date(now - 24 * HOUR_MS),
      },
    ]);
    await db.insert(eventRsvps).values([
      { eventId: id.upcoming, userId: alex.id },
      { eventId: id.upcoming, userId: sam.id },
    ]);
  }, SLOW);

  afterAll(async () => {
    if (eventIds.length > 0) {
      await db.delete(eventRsvps).where(inArray(eventRsvps.eventId, eventIds));
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.eventId, eventIds));
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  it("splits each event into first-timers and returning members, oldest first", async () => {
    const result = await callerFor(admin).chapter.turnout({ period: "all" });
    const mine = result.events.filter((row) => eventIds.includes(row.id));

    expect(mine.map((row) => row.id)).toEqual([id.first, id.second]);
    expect(mine[0]).toMatchObject({
      checkIns: 1,
      firstTimers: 1,
      returning: 0,
    });
    expect(mine[1]).toMatchObject({
      checkIns: 2,
      firstTimers: 1,
      returning: 1,
    });
  });

  it("counts RSVPs for upcoming events", async () => {
    const result = await callerFor(admin).chapter.turnout({ period: "all" });
    expect(result.upcoming.find((row) => row.id === id.upcoming)?.rsvps).toBe(
      2,
    );
  });

  it("is officers only", async () => {
    const member = { ...admin, role: "MEMBER" as const };
    await expect(
      callerFor(member).chapter.turnout({ period: "all" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
