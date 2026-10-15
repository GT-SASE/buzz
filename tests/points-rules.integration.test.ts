import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, eventCheckIns, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { and, eq, inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;

type TestUser = {
  id: string;
  email: string;
  role: "MEMBER" | "ADMIN" | "SUPER_ADMIN";
};

function callerFor(user: TestUser) {
  return createCaller({
    db,
    session: {
      user: { id: user.id, role: user.role, email: user.email, name: user.id },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    },
    headers: new Headers(),
  });
}

/**
 * Every event here sits in 2001, one day apart. Streaks walk the whole chapter
 * timeline, so a private stretch of history keeps whatever else lives in the
 * database from turning up as a "happening" between these events. An officer
 * stamps them with manualCheckIn, which has no check-in window.
 *
 * Catch-up pays against the median of every member's live total, so the
 * expected numbers below assume a database with no other check-ins in it. The
 * running totals are noted beside each step.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const dayAt = (n: number) => new Date(Date.UTC(2001, 0, 1) + n * DAY_MS);

describe.skipIf(!process.env.DATABASE_URL)("points rules", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  let seq = 0;

  let officer: TestUser;
  let deputy: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `pts-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role } satisfies TestUser;
  }

  async function makeEvent(
    day: number,
    label: string,
    archived = false,
    pointsValue = 10,
  ) {
    seq += 1;
    const [row] = await db
      .insert(events)
      .values({
        title: `pts ${label} ${suffix}`,
        startsAt: dayAt(day),
        pointsValue,
        // Unique, and never a real alphabet code.
        checkInCode:
          `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase(),
        createdById: officer.id,
        archivedAt: archived ? new Date() : null,
      })
      .returning({ id: events.id });
    eventIds.push(row!.id);
    return row!.id;
  }

  /** History written straight to the table, as if stamped long ago. */
  async function attend(eventId: string, user: TestUser, pointsEarned = 10) {
    await db
      .insert(eventCheckIns)
      .values({ eventId, userId: user.id, pointsEarned });
  }

  async function stamp(eventId: string, user: TestUser) {
    await callerFor(officer).event.manualCheckIn({
      eventId,
      email: user.email,
    });
    return pointsOf(eventId, user);
  }

  async function pointsOf(eventId: string, user: TestUser) {
    const row = await db.query.eventCheckIns.findFirst({
      where: and(
        eq(eventCheckIns.eventId, eventId),
        eq(eventCheckIns.userId, user.id),
      ),
    });
    return row?.pointsEarned;
  }

  beforeAll(async () => {
    resetRateLimits();
    officer = await makeUser("officer", "ADMIN");
    deputy = await makeUser("deputy", "ADMIN");
  }, SLOW);

  afterAll(async () => {
    if (eventIds.length > 0) {
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.eventId, eventIds));
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  it(
    "pays officers a flat point and lets them use up no early-bird spot",
    async () => {
      const m1 = await makeUser("early-m1", "MEMBER");
      const m2 = await makeUser("early-m2", "MEMBER");
      const m3 = await makeUser("early-m3", "MEMBER");
      const event = await makeEvent(0, "early bird");

      // Officers first: a flat point, no early-bird, and no spot used up.
      expect(await stamp(event, deputy)).toBe(1);
      const boss = await makeUser("early-boss", "SUPER_ADMIN");
      expect(await stamp(event, boss)).toBe(1);
      // First member in: 10 + 5, and nobody else to catch up to.
      expect(await stamp(event, m1)).toBe(15);
      // 10 + 4 early + catch-up min(10, ceil((15 - 0) / 2)) = 8. The officers'
      // 1s are not in the median.
      expect(await stamp(event, m2)).toBe(22);
      // Third member arrival: 10 + 3 early + catch-up min(10, ceil((18.5 - 0) / 2)).
      expect(await stamp(event, m3)).toBe(23);
    },
    SLOW,
  );

  describe("streak and archive", () => {
    let reg: TestUser;
    let other: TestUser;
    let newcomer: TestUser;
    const ev = {} as Record<string, string>;

    it(
      "steps down one level per miss, and starts newcomers fresh",
      async () => {
        reg = await makeUser("reg", "MEMBER");
        other = await makeUser("other", "MEMBER");
        newcomer = await makeUser("newcomer", "MEMBER");

        // Ten members on 1 point each pin the catch-up median at 1, whatever
        // earlier steps (or other rows in the database) left behind, so this
        // block never pays catch-up and does not depend on its neighbours.
        ev.filler = await makeEvent(5, "filler");
        for (let i = 0; i < 10; i += 1) {
          await attend(ev.filler, await makeUser(`filler${i}`, "MEMBER"), 1);
        }

        // reg attends h1-h3; "other" keeps every event a happening.
        for (const [day, key] of [
          [10, "h1"],
          [11, "h2"],
          [12, "h3"],
        ] as const) {
          ev[key] = await makeEvent(day, key);
          await attend(ev[key], other);
          await attend(ev[key], reg);
        }

        // Level 3, no miss yet: 10 base + 4 early (other was in) + 6. reg (30)
        // is above the median (1), so no catch-up.
        ev.t1 = await makeEvent(13, "t1");
        await attend(ev.t1, other);
        expect(await stamp(ev.t1, reg)).toBe(20);

        // One miss costs a level, not the lot: still level 3 after climbing
        // to 4, so +6.
        ev.h5 = await makeEvent(14, "h5");
        await attend(ev.h5, other);
        ev.t2 = await makeEvent(15, "t2");
        await attend(ev.t2, other);
        expect(await stamp(ev.t2, reg)).toBe(20);

        // Two more misses after a hit at level 4: back down to level 2, +4.
        ev.h7 = await makeEvent(16, "h7");
        await attend(ev.h7, other);
        ev.h8 = await makeEvent(17, "h8");
        await attend(ev.h8, other);
        await attend(ev.h8, newcomer);
        ev.t3 = await makeEvent(18, "t3");
        await attend(ev.t3, other);
        expect(await stamp(ev.t3, reg)).toBe(18);

        // Newcomer's first event was h8: h1-h7 are not held against them.
        // 10 base + 3 early (other and reg were in) + 2 streak; 10 is above the
        // median (1), so no catch-up.
        expect(await stamp(ev.t3, newcomer)).toBe(15);
      },
      SLOW,
    );

    it(
      "ignores an archived event as a happening",
      async () => {
        await callerFor(officer).event.setArchived({
          id: ev.h7!,
          archived: true,
        });
        // Without h7 the walk ends t2 (4), h8 miss (3), t3 hit (4) = +8.
        // Counting h7 it would be 4, 3, 2, 3 = +6.
        ev.t4 = await makeEvent(19, "t4");
        await attend(ev.t4, other);
        // 10 base + 4 early (other was in) + 8; reg is far above the median.
        expect(await stamp(ev.t4, reg)).toBe(22);
      },
      SLOW,
    );

    it(
      "counts a restored event as a happening again",
      async () => {
        await callerFor(officer).event.setArchived({
          id: ev.h7!,
          archived: false,
        });
        // Attended h3, t1, t2, t3 and skipped everything else. Counting h7 the
        // walk after t2 (2) is h7 miss (1), h8 miss (0), t3 hit (1), t4 miss
        // (0). Without h7 it would be h8 miss (1), t3 hit (2), t4 miss (1),
        // worth +2.
        const late = await makeUser("late", "MEMBER");
        for (const key of ["h3", "t1", "t2", "t3"] as const) {
          await attend(ev[key]!, late);
        }
        ev.t5 = await makeEvent(20, "t5");
        // 10 base + 5 early (first member in) + 0 streak. late (40) is above
        // the median (1), so no catch-up.
        expect(await stamp(ev.t5, late)).toBe(15);
      },
      SLOW,
    );

    it(
      "drops an archived event from totals, leaderboard and lists, then restores it",
      async () => {
        const caller = callerFor(reg);
        const t1Points = (await pointsOf(ev.t1!, reg))!;

        // Only ever came to t1, so archiving it leaves them with nothing live.
        const ghost = await makeUser("ghost", "MEMBER");
        await attend(ev.t1!, ghost);
        const staff = callerFor(officer);
        const rosterFor = async () => {
          const list = await staff.member.list({ search: suffix, limit: 100 });
          const exported = await staff.member.exportRoster({ search: suffix });
          return { list: list.members, exported: exported.members };
        };
        const pointsIn = (
          rows: { email: string | null; totalPoints: number }[],
        ) => rows.find((r) => r.email === reg.email)?.totalPoints;
        const rosterBefore = await rosterFor();
        const metricsBefore = await staff.member.metrics({});

        const before = await caller.event.myStats();
        const boardBefore = await caller.member.leaderboard({});
        expect(
          (await caller.event.home()).attended.some((r) => r.id === ev.t1),
        ).toBe(true);

        await callerFor(officer).event.setArchived({
          id: ev.t1!,
          archived: true,
        });

        const after = await caller.event.myStats();
        expect(after.totalPoints).toBe(before.totalPoints - t1Points);
        expect(after.totalEvents).toBe(before.totalEvents - 1);
        expect((await caller.member.leaderboard({})).you?.totalPoints).toBe(
          boardBefore.you!.totalPoints - t1Points,
        );
        expect(
          (await caller.event.myEvents()).some((r) => r.id === ev.t1),
        ).toBe(false);
        const home = await caller.event.home();
        expect(home.attended.some((r) => r.id === ev.t1)).toBe(false);
        expect(home.stats.totalPoints).toBe(after.totalPoints);

        const detail = await callerFor(officer).member.byId({ id: reg.id });
        expect(detail.totalPoints).toBe(after.totalPoints);
        expect(detail.history.some((r) => r.eventId === ev.t1)).toBe(false);

        // Roster reads: totals drop, the ghost stays listed with 0 and sorts
        // behind everyone who has points, in both the list and the CSV.
        const rosterAfter = await rosterFor();
        for (const key of ["list", "exported"] as const) {
          expect(pointsIn(rosterAfter[key])).toBe(
            pointsIn(rosterBefore[key])! - t1Points,
          );
          const ghostIndex = rosterAfter[key].findIndex(
            (r) => r.email === ghost.email,
          );
          expect(ghostIndex).toBeGreaterThan(-1);
          expect(rosterAfter[key][ghostIndex]!.totalPoints).toBe(0);
          expect(ghostIndex).toBeGreaterThan(
            rosterAfter[key].findIndex((r) => r.email === reg.email),
          );
        }
        const metricsAfter = await staff.member.metrics({});
        expect(metricsAfter.withCheckIns).toBe(metricsBefore.withCheckIns - 1);
        expect(metricsAfter.neverCheckedIn).toBe(
          metricsBefore.neverCheckedIn + 1,
        );

        // The event's own roster still shows the row for officers.
        const roster = await callerFor(officer).event.getById({ id: ev.t1! });
        expect(roster.roster.some((r) => r.userId === reg.id)).toBe(true);

        await callerFor(officer).event.setArchived({
          id: ev.t1!,
          archived: false,
        });
        const restored = await caller.event.myStats();
        expect(restored.totalPoints).toBe(before.totalPoints);
        expect(restored.totalEvents).toBe(before.totalEvents);
        expect((await caller.member.leaderboard({})).you?.totalPoints).toBe(
          boardBefore.you!.totalPoints,
        );
        expect(
          (await caller.event.myEvents()).some((r) => r.id === ev.t1),
        ).toBe(true);
        expect(
          (await caller.event.home()).attended.some((r) => r.id === ev.t1),
        ).toBe(true);
        const detailBack = await staff.member.byId({ id: reg.id });
        expect(detailBack.totalPoints).toBe(before.totalPoints);
        expect(detailBack.history.some((r) => r.eventId === ev.t1)).toBe(true);
        const rosterBack = await rosterFor();
        expect(pointsIn(rosterBack.list)).toBe(pointsIn(rosterBefore.list));
        expect(pointsIn(rosterBack.exported)).toBe(
          pointsIn(rosterBefore.exported),
        );
        const metricsBack = await staff.member.metrics({});
        expect(metricsBack.withCheckIns).toBe(metricsBefore.withCheckIns);
        expect(metricsBack.neverCheckedIn).toBe(metricsBefore.neverCheckedIn);
      },
      SLOW,
    );
  });

  it(
    "pays nothing for a zero-point event, officer or member",
    async () => {
      const free = await makeUser("free", "MEMBER");
      const event = await makeEvent(45, "zero points", false, 0);
      expect(await stamp(event, deputy)).toBe(0);
      expect(await stamp(event, free)).toBe(0);
    },
    SLOW,
  );

  it(
    "refuses an officer adding their own email: officers scan too",
    async () => {
      const event = await makeEvent(40, "self add");
      await expect(
        callerFor(officer).event.manualCheckIn({
          eventId: event,
          email: officer.email,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await pointsOf(event, officer)).toBeUndefined();
    },
    SLOW,
  );

  it(
    "checks an officer in by scanning the code, like a member",
    async () => {
      seq += 1;
      const code =
        `${suffix.slice(0, 6)}${String(seq).padStart(2, "0")}`.toUpperCase();
      const [row] = await db
        .insert(events)
        .values({
          title: `pts scan ${suffix}`,
          startsAt: new Date(),
          pointsValue: 10,
          checkInCode: code,
          createdById: officer.id,
        })
        .returning({ id: events.id });
      eventIds.push(row!.id);

      const caller = callerFor(deputy);
      await caller.event.checkIn({ code });
      const saved = await db.query.eventCheckIns.findFirst({
        where: and(
          eq(eventCheckIns.eventId, row!.id),
          eq(eventCheckIns.userId, deputy.id),
        ),
      });
      expect(saved).toMatchObject({
        method: "code",
        actedByUserId: null,
        pointsEarned: 1,
      });
      await expect(caller.event.checkIn({ code })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    },
    SLOW,
  );

  it(
    "ignores archived check-ins for voting eligibility",
    async () => {
      const voter = await makeUser("voter", "MEMBER");
      const event = await makeEvent(30, "eligibility");
      await attend(event, voter);

      const caller = callerFor(voter);
      expect((await caller.election.current()).eligible).toBe(true);

      await callerFor(officer).event.setArchived({ id: event, archived: true });
      expect((await caller.election.current()).eligible).toBe(false);

      await callerFor(officer).event.setArchived({
        id: event,
        archived: false,
      });
      expect((await caller.election.current()).eligible).toBe(true);
    },
    SLOW,
  );
});
