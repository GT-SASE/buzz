import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, kinGroups, mentorshipEnrollments, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { kinYear } = await import("../packages/api/src/kin-year");
const { inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

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
    resetRateLimits();
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
      year: kinYear(new Date()),
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

  it("rejects a duplicate group name in the same year", async () => {
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

  it("starts a new school year from scratch", async () => {
    const lastYear = "2019-2020";
    await db.insert(mentorshipEnrollments).values({
      userId: mentor.id,
      year: lastYear,
      role: "mentor",
      status: "enrolled",
      points: 40,
    });

    const current = await callerFor(mentor).mentorship.mine();
    expect(current?.year).toBe(kinYear(new Date()));

    const history = await callerFor(officer).mentorship.list({
      year: lastYear,
    });
    expect(history.find((row) => row.userId === mentor.id)?.points).toBe(40);
    expect(await callerFor(officer).mentorship.years()).toContain(lastYear);
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
