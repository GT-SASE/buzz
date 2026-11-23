import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, eventRsvps, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { eq, inArray } = await import("drizzle-orm");

const HOUR_MS = 60 * 60 * 1000;
const SLOW = 30_000;

function callerFor(user: { id: string; email: string } | null) {
  return createCaller({
    db,
    session: user && {
      user: { id: user.id, role: "MEMBER", email: user.email, name: "vitest" },
      expires: new Date(Date.now() + 24 * HOUR_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe.skipIf(!process.env.DATABASE_URL)("event.myRsvps", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  let me: { id: string; email: string };
  let other: { id: string; email: string };
  const id = { going: "", also: "", notGoing: "", theirs: "" };

  async function makeUser(tag: string) {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-rsvp-status-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag}`,
        role: "MEMBER",
      })
      .returning();
    if (!row) throw new Error(`could not create the ${tag} test user`);
    userIds.push(row.id);
    return { id: row.id, email: row.email };
  }

  beforeAll(async () => {
    me = await makeUser("me");
    other = await makeUser("other");
    const rows = await db
      .insert(events)
      .values(
        (["going", "also", "notGoing", "theirs"] as const).map(
          (tag, index) => ({
            title: `vitest rsvp status ${tag}`,
            startsAt: new Date(Date.now() + (48 + index) * HOUR_MS),
            checkInCode: `S${suffix.slice(0, 5)}${index}`.toUpperCase(),
            createdById: me.id,
          }),
        ),
      )
      .returning();
    for (const row of rows) eventIds.push(row.id);
    [id.going, id.also, id.notGoing, id.theirs] = eventIds as [
      string,
      string,
      string,
      string,
    ];
    await db.insert(eventRsvps).values([
      { eventId: id.going, userId: me.id },
      { eventId: id.also, userId: me.id },
      { eventId: id.theirs, userId: other.id },
    ]);
  }, SLOW);

  afterAll(async () => {
    await db.delete(events).where(inArray(events.id, eventIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }, SLOW);

  it("returns the ones the member has RSVPed to, and no one else's", async () => {
    const going = await callerFor(me).event.myRsvps({
      eventIds: [id.going, id.also, id.notGoing, id.theirs],
    });
    expect([...going].sort()).toEqual([id.going, id.also].sort());
  });

  it("only answers about the ids it was asked about", async () => {
    expect(
      await callerFor(me).event.myRsvps({ eventIds: [id.also, id.notGoing] }),
    ).toEqual([id.also]);
  });

  it("answers per member", async () => {
    expect(
      await callerFor(other).event.myRsvps({
        eventIds: [id.going, id.theirs],
      }),
    ).toEqual([id.theirs]);
  });

  it("is empty for no ids and for ids nobody has", async () => {
    expect(await callerFor(me).event.myRsvps({ eventIds: [] })).toEqual([]);
    expect(
      await callerFor(me).event.myRsvps({ eventIds: [crypto.randomUUID()] }),
    ).toEqual([]);
  });

  it("is for signed-in members only", async () => {
    expect(
      await errorCode(callerFor(null).event.myRsvps({ eventIds: [id.going] })),
    ).toBe("UNAUTHORIZED");
  });

  it("refuses a list longer than the pages ever send", async () => {
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect(
      await errorCode(callerFor(me).event.myRsvps({ eventIds: tooMany })),
    ).toBe("BAD_REQUEST");
    expect(
      await callerFor(me).event.myRsvps({ eventIds: tooMany.slice(0, 100) }),
    ).toEqual([]);
  });

  it("stays in step with event.rsvp and event.cancelRsvp", async () => {
    const caller = callerFor(me);
    await caller.event.rsvp({ eventId: id.notGoing });
    expect(await caller.event.myRsvps({ eventIds: [id.notGoing] })).toEqual([
      id.notGoing,
    ]);
    await caller.event.cancelRsvp({ eventId: id.notGoing });
    expect(await caller.event.myRsvps({ eventIds: [id.notGoing] })).toEqual([]);
    await db.delete(eventRsvps).where(eq(eventRsvps.eventId, id.notGoing));
  });
});
