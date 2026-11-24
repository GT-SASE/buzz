import { afterAll, describe, expect, it, mock } from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, mentorshipEnrollments, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { eq, inArray } = await import("drizzle-orm");

type TestUser = { id: string; email: string; role: "MEMBER" };

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

describe.skipIf(!process.env.DATABASE_URL)("mentorship signup", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];

  async function makeUser(label: string): Promise<TestUser> {
    const id = `ment-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role: "MEMBER", name: label });
    userIds.push(id);
    return { id, email, role: "MEMBER" };
  }

  const signupsOf = (user: TestUser) =>
    db
      .select()
      .from(mentorshipEnrollments)
      .where(eq(mentorshipEnrollments.userId, user.id));

  afterAll(async () => {
    await db
      .delete(mentorshipEnrollments)
      .where(inArray(mentorshipEnrollments.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("answers a double click with the same signup, not a server error", async () => {
    const member = await makeUser("double-click");
    const clicks = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        callerFor(member).mentorship.expressInterest({
          role: "mentee",
          note: "first year",
        }),
      ),
    );

    expect(clicks.filter((click) => click.status === "rejected")).toHaveLength(
      0,
    );
    const rows = await signupsOf(member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      role: "mentee",
      status: "interested",
      note: "first year",
    });
  });

  it("lets a signup change role and keeps an enrolled member enrolled", async () => {
    const member = await makeUser("changes-role");
    await callerFor(member).mentorship.expressInterest({ role: "mentee" });
    await db
      .update(mentorshipEnrollments)
      .set({ status: "enrolled", enrolledAt: new Date() })
      .where(eq(mentorshipEnrollments.userId, member.id));

    const again = await callerFor(member).mentorship.expressInterest({
      role: "mentor",
      note: "switching",
    });

    expect(again).toMatchObject({
      role: "mentor",
      status: "enrolled",
      note: "switching",
    });
    expect(await signupsOf(member)).toHaveLength(1);
  });
});
