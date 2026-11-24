import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, kinGroups, kinMemberships, mentorshipEnrollments, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { schoolYear, semester } = await import("../packages/api/src/terms");
const { and, eq, inArray } = await import("drizzle-orm");

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

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

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe.skipIf(!process.env.DATABASE_URL)("kin groups", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const groupIds: string[] = [];
  let officer: TestUser;
  let mentor: TestUser;
  let menteeA: TestUser;
  let menteeB: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `kin-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role };
  }

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
    mentor = await makeUser("mentor", "MEMBER");
    menteeA = await makeUser("mentee-a", "MEMBER");
    menteeB = await makeUser("mentee-b", "MEMBER");
  });

  afterAll(async () => {
    await db
      .delete(mentorshipEnrollments)
      .where(inArray(mentorshipEnrollments.userId, userIds));
    if (groupIds.length > 0) {
      await db.delete(kinGroups).where(inArray(kinGroups.id, groupIds));
    }
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("runs signup, join, capacity, standings, group award, and leave", async () => {
    const created = await callerFor(officer).mentorship.createGroup({
      name: `Honeycomb ${suffix}`,
      description: "",
      capacity: 2,
      isOpen: true,
    });
    groupIds.push(created!.id);
    expect(created).toMatchObject({
      year: schoolYear(new Date()),
      semester: semester(new Date()),
      description: null,
    });

    expect(
      await errorCode(
        callerFor(menteeA).mentorship.joinGroup({ groupId: created!.id }),
      ),
    ).toBe("BAD_REQUEST");

    for (const [user, role] of [
      [mentor, "mentor"],
      [menteeA, "mentee"],
      [menteeB, "mentee"],
    ] as const) {
      await callerFor(user).mentorship.expressInterest({ role });
    }

    await callerFor(mentor).mentorship.joinGroup({ groupId: created!.id });
    await callerFor(menteeA).mentorship.joinGroup({ groupId: created!.id });
    expect(
      await errorCode(
        callerFor(menteeB).mentorship.joinGroup({ groupId: created!.id }),
      ),
    ).toBe("BAD_REQUEST");

    const mine = await callerFor(menteeA).mentorship.myGroup();
    expect(mine?.members.map((member) => member.userId).sort()).toEqual(
      [mentor.id, menteeA.id].sort(),
    );

    const award = await callerFor(officer).mentorship.awardGroupPoints({
      groupId: created!.id,
      points: 5,
    });
    expect(award.awarded).toBe(2);

    const listed = (await callerFor(menteeB).mentorship.groups()).find(
      (group) => group.id === created!.id,
    );
    expect(listed).toMatchObject({
      memberCount: 2,
      points: 10,
      mentors: ["mentor"],
    });

    await callerFor(menteeA).mentorship.leaveGroup();
    const afterLeave = await callerFor(menteeA).mentorship.mine();
    expect(afterLeave).toMatchObject({
      status: "interested",
      groupId: null,
      points: 5,
    });

    await callerFor(menteeB).mentorship.joinGroup({ groupId: created!.id });
  });

  it("lets an officer seat someone in an invite-only group", async () => {
    const closed = await callerFor(officer).mentorship.createGroup({
      name: `Invite ${suffix}`,
      capacity: null,
      isOpen: false,
    });
    groupIds.push(closed!.id);

    expect(
      await errorCode(
        callerFor(menteeA).mentorship.joinGroup({ groupId: closed!.id }),
      ),
    ).toBe("BAD_REQUEST");

    await callerFor(officer).mentorship.assignGroup({
      userId: menteeA.id,
      groupId: closed!.id,
    });
    expect(await callerFor(menteeA).mentorship.mine()).toMatchObject({
      groupId: closed!.id,
      status: "enrolled",
    });
  });

  it("rejects a duplicate group name in the same semester", async () => {
    expect(
      await errorCode(
        callerFor(officer).mentorship.createGroup({
          name: `honeycomb ${suffix}`,
          capacity: null,
          isOpen: true,
        }),
      ),
    ).toBe("CONFLICT");
  });

  it("keeps groups per semester and points per school year", async () => {
    const now = new Date();
    const otherTerm = semester(now).startsWith("fall")
      ? `spring-${Number(schoolYear(now).slice(5))}`
      : `fall-${schoolYear(now).slice(0, 4)}`;
    const [past] = await db
      .insert(kinGroups)
      .values({
        name: `Other term ${suffix}`,
        year: schoolYear(now),
        semester: otherTerm,
      })
      .returning();
    groupIds.push(past!.id);
    await db
      .insert(kinMemberships)
      .values({ userId: officer.id, semester: otherTerm, groupId: past!.id });

    const current = await callerFor(officer).mentorship.groups();
    expect(current.some((group) => group.id === past!.id)).toBe(false);
    const other = await callerFor(officer).mentorship.groups({
      semester: otherTerm,
    });
    expect(other.find((group) => group.id === past!.id)).toBeTruthy();
    expect(await callerFor(officer).mentorship.semesters()).toContain(
      otherTerm,
    );

    const before = await callerFor(mentor).mentorship.mine();
    expect(before?.year).toBe(schoolYear(now));
    expect(before?.points).toBeGreaterThan(0);
  });

  it("starts a new school year from scratch", async () => {
    await db.insert(mentorshipEnrollments).values({
      userId: mentor.id,
      year: "2019-2020",
      role: "mentor",
      status: "enrolled",
      points: 40,
    });

    const history = await callerFor(officer).mentorship.list({
      semester: "spring-2020",
    });
    expect(history.find((row) => row.userId === mentor.id)?.points).toBe(40);
    const current = await callerFor(mentor).mentorship.mine();
    expect(current?.year).toBe(schoolYear(new Date()));
  });

  it("returns deleted group members to signed up", async () => {
    await callerFor(officer).mentorship.deleteGroup({ id: groupIds[0]! });
    expect(await callerFor(menteeB).mentorship.mine()).toMatchObject({
      status: "interested",
      groupId: null,
    });
    groupIds.shift();
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "deleteGroup across semesters",
  () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const year = "2031-2032";
    const userIds: string[] = [];
    const groupIds: string[] = [];
    let officer: TestUser;
    let both: TestUser;
    let fallOnly: TestUser;
    let fallGroupId = "";

    async function makeUser(label: string, role: TestUser["role"]) {
      const id = `kin-del-${label}-${suffix}`;
      const email = `${id}@vitest.local`;
      await db.insert(users).values({ id, email, role, name: label });
      userIds.push(id);
      return { id, email, role };
    }

    async function status(user: TestUser) {
      const [row] = await db
        .select({ status: mentorshipEnrollments.status })
        .from(mentorshipEnrollments)
        .where(
          and(
            eq(mentorshipEnrollments.userId, user.id),
            eq(mentorshipEnrollments.year, year),
          ),
        );
      return row?.status;
    }

    beforeAll(async () => {
      officer = await makeUser("officer", "ADMIN");
      both = await makeUser("both", "MEMBER");
      fallOnly = await makeUser("fall-only", "MEMBER");
      const groups = await db
        .insert(kinGroups)
        .values([
          { name: `Del fall ${suffix}`, year, semester: "fall-2031" },
          { name: `Del spring ${suffix}`, year, semester: "spring-2032" },
        ])
        .returning();
      const fall = groups.find((group) => group.semester === "fall-2031")!;
      const spring = groups.find((group) => group.semester === "spring-2032")!;
      fallGroupId = fall.id;
      groupIds.push(fall.id, spring.id);
      await db.insert(mentorshipEnrollments).values(
        [both, fallOnly].map((user) => ({
          userId: user.id,
          year,
          role: "mentee" as const,
          status: "enrolled" as const,
          enrolledAt: new Date(),
        })),
      );
      await db.insert(kinMemberships).values([
        { userId: both.id, semester: "fall-2031", groupId: fall.id },
        { userId: both.id, semester: "spring-2032", groupId: spring.id },
        { userId: fallOnly.id, semester: "fall-2031", groupId: fall.id },
      ]);
    });

    afterAll(async () => {
      await db
        .delete(mentorshipEnrollments)
        .where(inArray(mentorshipEnrollments.userId, userIds));
      await db.delete(kinGroups).where(inArray(kinGroups.id, groupIds));
      await db.delete(users).where(inArray(users.id, userIds));
    });

    it("keeps enrollment for someone still seated in another semester of the year, and resets the rest", async () => {
      await callerFor(officer).mentorship.deleteGroup({ id: fallGroupId });
      expect(await status(both)).toBe("enrolled");
      expect(await status(fallOnly)).toBe("interested");
    });
  },
);
