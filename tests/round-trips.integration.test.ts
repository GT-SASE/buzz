import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * Pins what the round-trip collapses in packages/api must not change: the
 * officer overview's figures (three queries now, eight before), the kin
 * group roster (two parallel reads instead of three in a row), and an event
 * lookup that now runs beside its roster instead of ahead of it.
 *
 * Numbers are compared as before/after deltas so the test holds on a database
 * that already has data in it.
 */
mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const {
  db,
  eventCheckIns,
  events,
  kinGroups,
  kinMemberships,
  mentorshipEnrollments,
  users,
} = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { schoolYear, semester } = await import("../packages/api/src/terms");
const { inArray } = await import("drizzle-orm");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SLOW = 30_000;

function callerFor(id: string, role: "MEMBER" | "ADMIN") {
  return createCaller({
    db,
    session: {
      user: { id, role, email: `${id}@example.invalid`, name: "vitest" },
      expires: new Date(Date.now() + DAY_MS).toISOString(),
    },
    headers: new Headers(),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("round-trip collapses", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const groupIds: string[] = [];
  const term = semester(new Date());
  let officer = "";
  let alex = "";
  let sam = "";
  let pastEvent = "";
  let before: Awaited<
    ReturnType<ReturnType<typeof callerFor>["chapter"]["overview"]>
  >;

  async function makeUser(tag: string, role: "MEMBER" | "ADMIN") {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-rt-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag} ${suffix}`,
        role,
      })
      .returning({ id: users.id });
    userIds.push(row!.id);
    return row!.id;
  }

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
    alex = await makeUser("alex", "MEMBER");
    sam = await makeUser("sam", "MEMBER");
    before = await callerFor(officer, "ADMIN").chapter.overview();

    const now = Date.now();
    const rows = await db
      .insert(events)
      .values([
        {
          title: `vitest rt past ${suffix}`,
          startsAt: new Date(now - 3 * DAY_MS),
          checkInCode: `RT${suffix}1`.slice(0, 12).toUpperCase(),
          createdById: officer,
        },
        {
          title: `vitest rt older ${suffix}`,
          startsAt: new Date(now - 60 * DAY_MS),
          checkInCode: `RT${suffix}2`.slice(0, 12).toUpperCase(),
          createdById: officer,
        },
        {
          title: `vitest rt upcoming ${suffix}`,
          startsAt: new Date(now + 3 * DAY_MS),
          checkInCode: `RT${suffix}3`.slice(0, 12).toUpperCase(),
          createdById: officer,
        },
        {
          // Archived: counts for nothing anywhere on the overview.
          title: `vitest rt archived ${suffix}`,
          startsAt: new Date(now - 2 * DAY_MS),
          checkInCode: `RT${suffix}4`.slice(0, 12).toUpperCase(),
          createdById: officer,
          archivedAt: new Date(),
        },
      ])
      .returning({ id: events.id, title: events.title });
    for (const row of rows) {
      eventIds.push(row.id);
      if (row.title.includes("rt past")) pastEvent = row.id;
    }
    const byTitle = (part: string) =>
      rows.find((row) => row.title.includes(part))!.id;

    await db.insert(eventCheckIns).values([
      // Alex: recent + old live check-ins. Sam: one live, one archived.
      {
        eventId: byTitle("rt past"),
        userId: alex,
        pointsEarned: 10,
        checkedInAt: new Date(now - 3 * DAY_MS),
      },
      {
        eventId: byTitle("rt older"),
        userId: alex,
        pointsEarned: 10,
        checkedInAt: new Date(now - 60 * DAY_MS),
      },
      {
        eventId: byTitle("rt past"),
        userId: sam,
        pointsEarned: 10,
        checkedInAt: new Date(now - 3 * DAY_MS),
      },
      {
        eventId: byTitle("rt archived"),
        userId: sam,
        pointsEarned: 10,
        checkedInAt: new Date(now - 2 * DAY_MS),
      },
    ]);

    // Kin: one group this semester, alex mentor + sam mentee seated in it.
    const year = schoolYear(new Date());
    const [group] = await db
      .insert(kinGroups)
      .values({
        year,
        semester: term,
        name: `vitest rt kin ${suffix}`,
        capacity: 5,
        isOpen: true,
      })
      .returning({ id: kinGroups.id });
    groupIds.push(group!.id);
    await db.insert(mentorshipEnrollments).values([
      { userId: alex, year, role: "mentor", status: "enrolled" },
      { userId: sam, year, role: "mentee", status: "enrolled" },
    ]);
    await db.insert(kinMemberships).values([
      { userId: alex, semester: term, groupId: group!.id },
      { userId: sam, semester: term, groupId: group!.id },
    ]);
  }, SLOW);

  afterAll(async () => {
    if (eventIds.length > 0) {
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (groupIds.length > 0) {
      await db.delete(kinGroups).where(inArray(kinGroups.id, groupIds));
    }
  }, SLOW);

  it(
    "overview counts live events and their check-ins, and nothing archived",
    async () => {
      const after = await callerFor(officer, "ADMIN").chapter.overview();

      // Three live events added (past, older, upcoming); the archived one is out.
      expect(after.events.total - before.events.total).toBe(3);
      expect(after.events.past - before.events.past).toBe(2);
      expect(after.events.upcoming - before.events.upcoming).toBe(1);
      // Three live check-ins; Sam's archived one is out. Two are inside 30 days.
      expect(after.checkIns.total - before.checkIns.total).toBe(3);
      expect(after.checkIns.last30Days - before.checkIns.last30Days).toBe(2);
      // Alex and Sam are the two new members with a live check-in.
      expect(after.members.withCheckIns - before.members.withCheckIns).toBe(2);
      expect(after.members.total - before.members.total).toBe(0);
    },
    SLOW,
  );

  it(
    "event.getById still answers NOT_FOUND for a missing event",
    async () => {
      const error = await callerFor(officer, "ADMIN")
        .event.getById({ id: "vitest-no-such-event" })
        .then(
          () => null,
          (caught: { code: string }) => caught,
        );
      expect(error?.code).toBe("NOT_FOUND");
    },
    SLOW,
  );

  it(
    "event.getById returns the event with its roster in one call",
    async () => {
      const result = await callerFor(officer, "ADMIN").event.getById({
        id: pastEvent,
      });
      expect(result.event.id).toBe(pastEvent);
      expect(result.rosterTotal).toBe(2);
      expect(result.roster.map((row) => row.userId).sort()).toEqual(
        [alex, sam].sort(),
      );
      expect(result.rsvps).toEqual([]);
    },
    SLOW,
  );

  it(
    "myGroup returns the group and everyone in it, mentors first",
    async () => {
      const mine = await callerFor(sam, "MEMBER").mentorship.myGroup();
      expect(mine?.name).toBe(`vitest rt kin ${suffix}`);
      expect(mine?.members.map((member) => member.userId)).toEqual([alex, sam]);
      expect(mine?.members.map((member) => member.role)).toEqual([
        "mentor",
        "mentee",
      ]);
    },
    SLOW,
  );

  it(
    "myGroup is null for a member with no seat this semester",
    async () => {
      const stranger = await makeUser("stranger", "MEMBER");
      expect(
        await callerFor(stranger, "MEMBER").mentorship.myGroup(),
      ).toBeNull();
    },
    SLOW,
  );

  it(
    "committee.mine reports the cycle state without an application",
    async () => {
      const result = await callerFor(alex, "MEMBER").committee.mine();
      expect(result.application).toBeNull();
      expect(typeof result.label).toBe("string");
    },
    SLOW,
  );
});
