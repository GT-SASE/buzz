import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";

mock.module("../../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, events, pointsLedger, users } =
  await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { inArray } =
  await import("../../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;

/**
 * The clock sits in fall 2031 (school year 2031-2032), a year no other test
 * writes to, so the semester and year boards see only this file's rows.
 * Atlanta is UTC-4 in summer and UTC-5 in winter: fall 2031 opens
 * 2031-08-01T04:00Z and closes at 2032-01-01T05:00Z, where spring 2032 begins.
 */
const NOW = new Date("2031-10-15T16:00:00Z");

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

function callerFor(user: TestUser, handle: typeof db = db) {
  return createCaller({
    db: handle,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: user.id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

/** A handle that records every `.limit(n)` a query built on it ends with. */
function spyOnLimits(limits: number[]) {
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(inner, property, receiver) {
        const value = Reflect.get(inner, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (property === "then") {
          return (value as (...rest: unknown[]) => unknown).bind(inner);
        }
        return (...args: unknown[]) => {
          if (property === "limit") limits.push(args[0] as number);
          const result = (value as (...rest: unknown[]) => unknown).apply(
            inner,
            args,
          );
          return result && typeof result === "object" ? wrap(result) : result;
        };
      },
    });
  return new Proxy(db, {
    get(inner, property, receiver) {
      const value = Reflect.get(inner, property, receiver) as unknown;
      if (property === "select" && typeof value === "function") {
        return (...args: unknown[]) =>
          wrap((value as (...rest: unknown[]) => object).apply(inner, args));
      }
      return typeof value === "function"
        ? (value as (...rest: unknown[]) => unknown).bind(inner)
        : value;
    },
  });
}

describe.skipIf(!process.env.DATABASE_URL)("leaderboard", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  let seq = 0;
  let officer: TestUser;

  async function makeUser(label: string, name: string | null = label) {
    const id = `lb-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role: "MEMBER", name });
    userIds.push(id);
    return { id, email, role: "MEMBER" } satisfies TestUser;
  }

  async function makeEvent(
    startsAt: string,
    pointsValue: number,
    archived = false,
  ) {
    seq += 1;
    const [row] = await db
      .insert(events)
      .values({
        title: `lb ${seq} ${suffix}`,
        startsAt: new Date(startsAt),
        pointsValue,
        checkInCode:
          `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase(),
        createdById: officer.id,
        archivedAt: archived ? new Date() : null,
      })
      .returning({ id: events.id, startsAt: events.startsAt });
    eventIds.push(row!.id);
    return row!;
  }

  /** A check-in's ledger row, as the check-in writers append it. */
  async function grant(
    user: TestUser,
    event: { id: string; startsAt: Date },
    delta: number,
  ) {
    await db.insert(pointsLedger).values({
      userId: user.id,
      delta,
      reason: "test check-in",
      source: "check_in",
      eventId: event.id,
      at: event.startsAt,
    });
  }

  /** Taking a check-in back, logged long after the event. */
  async function takeBack(
    user: TestUser,
    event: { id: string },
    delta: number,
    at: string,
  ) {
    await db.insert(pointsLedger).values({
      userId: user.id,
      delta: 0 - delta,
      reason: "test removal",
      source: "check_in_removed",
      eventId: event.id,
      at: new Date(at),
    });
  }

  beforeAll(async () => {
    setSystemTime(NOW);
    officer = { ...(await makeUser("officer")), role: "ADMIN" };
  }, SLOW);

  afterAll(async () => {
    setSystemTime();
    if (eventIds.length > 0) {
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  it(
    "puts each check-in in the period its event started in, Atlanta time",
    async () => {
      const alice = await makeUser("alice");
      const fall = await makeEvent("2031-09-10T18:00:00Z", 1_000_000);
      // 23:30 on December 31st in Atlanta, already January 1st in UTC.
      const lastFall = await makeEvent("2032-01-01T04:30:00Z", 2_000_000);
      // Midnight January 1st in Atlanta: the first instant of spring.
      const firstSpring = await makeEvent("2032-01-01T05:00:00Z", 4_000_000);
      // 23:30 on July 31st in Atlanta: still last school year.
      const lastYear = await makeEvent("2031-08-01T03:30:00Z", 8_000_000);
      // Midnight August 1st in Atlanta: the first instant of this school year.
      const firstFall = await makeEvent("2031-08-01T04:00:00Z", 16_000_000);
      for (const [event, points] of [
        [fall, 1_000_000],
        [lastFall, 2_000_000],
        [firstSpring, 4_000_000],
        [lastYear, 8_000_000],
        [firstFall, 16_000_000],
      ] as const) {
        await grant(alice, event, points);
      }

      const board = (period: "semester" | "year" | "all") =>
        callerFor(alice).member.leaderboard({ period, limit: 5 });

      expect((await board("semester")).you).toMatchObject({
        totalPoints: 19_000_000,
        totalEvents: 3,
      });
      expect((await board("year")).you).toMatchObject({
        totalPoints: 23_000_000,
        totalEvents: 4,
      });
      expect((await board("all")).you).toMatchObject({
        totalPoints: 31_000_000,
        totalEvents: 5,
      });
    },
    SLOW,
  );

  it(
    "nets a removal against the semester of its event, not the day it was logged",
    async () => {
      const bob = await makeUser("bob");
      const carol = await makeUser("carol");
      const fall = await makeEvent("2031-09-20T18:00:00Z", 5_000_000);
      const other = await makeEvent("2031-09-21T18:00:00Z", 3_000_000);

      await grant(bob, fall, 5_000_000);
      await takeBack(bob, fall, 5_000_000, "2032-02-01T12:00:00Z");
      await grant(carol, fall, 5_000_000);
      await grant(carol, other, 3_000_000);
      await takeBack(carol, other, 3_000_000, "2032-02-01T12:00:00Z");

      // Bob has nothing left in fall; the later removal is not a spring debt.
      for (const period of ["semester", "year"] as const) {
        expect(
          (await callerFor(bob).member.leaderboard({ period })).you,
        ).toBeNull();
      }
      expect(
        (await callerFor(carol).member.leaderboard({ period: "semester" })).you,
      ).toMatchObject({ totalPoints: 5_000_000, totalEvents: 1 });
    },
    SLOW,
  );

  it(
    "counts nothing for an archived event",
    async () => {
      const dave = await makeUser("dave");
      const archived = await makeEvent("2031-09-22T18:00:00Z", 7_000_000, true);
      await grant(dave, archived, 7_000_000);
      expect(
        (await callerFor(dave).member.leaderboard({ period: "semester" })).you,
      ).toBeNull();
    },
    SLOW,
  );

  it(
    "hides an opted-out name, keeps the rank, and sends the name to nobody",
    async () => {
      const erin = await makeUser("erin", "Erin Hidden");
      const frank = await makeUser("frank", "Frank Visible");
      const event = await makeEvent("2031-10-01T18:00:00Z", 2_000_000_000);
      await grant(erin, event, 2_000_000_000);
      await grant(frank, event, 1_999_000_000);

      const view = (viewer: TestUser) =>
        callerFor(viewer).member.leaderboard({ period: "semester", limit: 5 });

      expect(
        (await view(frank)).top.slice(0, 2).map((row) => row.name),
      ).toEqual(["Erin Hidden", "Frank Visible"]);

      expect(
        await callerFor(erin).member.setLeaderboardPreference({
          hideName: true,
        }),
      ).toEqual({ hideName: true });
      expect(await callerFor(erin).member.leaderboardPreference()).toEqual({
        hideName: true,
      });

      const seenByFrank = await view(frank);
      expect(seenByFrank.top[0]).toMatchObject({
        rank: 1,
        name: null,
        anonymous: true,
        isYou: false,
      });
      // Frank stays second: hiding a name does not shift anyone's rank.
      expect(seenByFrank.you?.rank).toBe(2);
      expect(JSON.stringify(seenByFrank)).not.toContain("Erin Hidden");

      const seenByErin = await view(erin);
      expect(seenByErin.top[0]).toMatchObject({
        rank: 1,
        name: null,
        anonymous: true,
        isYou: true,
      });
      expect(seenByErin.you?.rank).toBe(1);

      await callerFor(erin).member.setLeaderboardPreference({
        hideName: false,
      });
      expect((await view(frank)).top[0]?.name).toBe("Erin Hidden");
      expect(await callerFor(frank).member.leaderboardPreference()).toEqual({
        hideName: false,
      });
    },
    SLOW,
  );

  it(
    "ties share a rank, the next rank skips, and the cut stays at N rows",
    async () => {
      await db
        .delete(pointsLedger)
        .where(inArray(pointsLedger.userId, userIds));
      const top = await makeUser("tiea");
      const tied = [
        await makeUser("tieb"),
        await makeUser("tiec"),
        await makeUser("tied"),
      ];
      const last = await makeUser("tiee");
      const event = await makeEvent("2031-11-10T18:00:00Z", 1_000_000);
      await grant(top, event, 900_000_000);
      for (const member of tied) await grant(member, event, 500_000_000);
      await grant(last, event, 100_000_000);

      const result = await callerFor(tied[2]!).member.leaderboard({
        period: "semester",
        limit: 3,
      });

      // Strict N rows: the third tied member falls past the cut.
      expect(result.top.map((row) => row.rank)).toEqual([1, 2, 2]);
      expect(result.top).toHaveLength(3);
      // The viewer shares rank 2 whichever side of the cut they fall on.
      expect(result.you).toMatchObject({ rank: 2, totalPoints: 500_000_000 });

      const all = await callerFor(last).member.leaderboard({
        period: "semester",
        limit: 10,
      });
      expect(all.top.map((row) => row.rank)).toEqual([1, 2, 2, 2, 5]);
      expect(all.you?.rank).toBe(5);
    },
    SLOW,
  );

  it(
    "limits in SQL: the top N plus the viewer, never the whole board",
    async () => {
      // Earlier tests left big scores in the same school year; clear them
      // so the ranks here are the only ones.
      await db
        .delete(pointsLedger)
        .where(inArray(pointsLedger.userId, userIds));
      const members: TestUser[] = [];
      for (let i = 0; i < 6; i++) members.push(await makeUser(`ranked${i}`));
      // Spring 2032 is inside the school year but outside the semester, so
      // only the year board sees these six.
      const event = await makeEvent("2032-03-10T18:00:00Z", 1_000_000);
      for (const [i, member] of members.entries()) {
        await grant(member, event, 1_000_000_000 - i * 1_000_000);
      }

      const limits: number[] = [];
      const result = await callerFor(
        members[5]!,
        spyOnLimits(limits),
      ).member.leaderboard({ period: "year", limit: 3 });

      // The statement asks for the top three and the viewer, nothing more.
      expect(limits).toEqual([4]);
      expect(result.top.map((row) => row.rank)).toEqual([1, 2, 3]);
      expect(result.top.map((row) => row.name)).toEqual([
        "ranked0",
        "ranked1",
        "ranked2",
      ]);
      // Outside the top three and still told the true place.
      expect(result.you).toMatchObject({ totalEvents: 1 });
      expect(result.you!.rank).toBeGreaterThan(3);
      expect(result.top.some((row) => row.isYou)).toBe(false);
    },
    SLOW,
  );

  it(
    "the card and the board agree on this semester; the tier is all-time",
    async () => {
      const gina = await makeUser("gina");
      const fallA = await makeEvent("2031-09-05T18:00:00Z", 10);
      const fallB = await makeEvent("2031-10-05T18:00:00Z", 20);
      const spring = await makeEvent("2032-02-05T18:00:00Z", 40);
      const lastYear = await makeEvent("2031-03-05T18:00:00Z", 80);
      for (const event of [fallA, fallB, spring, lastYear]) {
        await callerFor(officer).event.manualCheckIn({
          eventId: event.id,
          email: gina.email,
        });
      }

      const read = async () => {
        const home = (await callerFor(gina).event.home()).stats;
        const board = await callerFor(gina).member.leaderboard({
          period: "semester",
        });
        return { home, board: board.you };
      };

      // Fall 2031: the card shows the semester, and so does the board.
      const fall = await read();
      expect(fall.home.semester).toEqual({ totalPoints: 30, totalEvents: 2 });
      expect(fall.board).toMatchObject({ totalPoints: 30, totalEvents: 2 });
      expect(fall.home).toMatchObject({ totalPoints: 150, totalEvents: 4 });

      // Spring 2032 starts from the spring event alone.
      setSystemTime(new Date("2032-02-10T16:00:00Z"));
      const springRead = await read();
      expect(springRead.home.semester).toEqual({
        totalPoints: 40,
        totalEvents: 1,
      });
      expect(springRead.board).toMatchObject({
        totalPoints: 40,
        totalEvents: 1,
      });

      // A new semester with no check-ins yet: zero on the card, nothing on
      // the board, and the all-time total the tier is read from has not moved.
      setSystemTime(new Date("2032-09-01T16:00:00Z"));
      const empty = await read();
      expect(empty.home.semester).toEqual({ totalPoints: 0, totalEvents: 0 });
      expect(empty.board).toBeNull();
      for (const result of [fall, springRead, empty]) {
        expect(result.home.totalPoints).toBe(150);
      }
      setSystemTime(NOW);
    },
    SLOW,
  );

  it("refuses a signed-out caller", async () => {
    const caller = createCaller({
      db,
      session: null,
      headers: new Headers(),
    });
    await expect(caller.member.leaderboard({})).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.member.setLeaderboardPreference({ hideName: true }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
