import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { auditLog, db, kinGroups, kinMemberships, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { and, eq, inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;

/** Fall 2031 asks for spring 2031. No other test writes to either. */
const NOW = new Date("2031-10-15T16:00:00Z");
const FROM = "spring-2031";
const TO = "fall-2031";

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

describe.skipIf(!process.env.DATABASE_URL)("kin carry-forward", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let officer: TestUser;
  let member: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `cf-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role };
  }

  async function clearGroups() {
    await db.delete(kinGroups).where(inArray(kinGroups.semester, [FROM, TO]));
    await db
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.action, "kin_group.carry_forward"),
          eq(auditLog.targetLabel, TO),
        ),
      );
  }

  async function seedLastSemester() {
    await clearGroups();
    await db.insert(kinGroups).values([
      {
        year: "2030-2031",
        semester: FROM,
        name: `Alpha ${suffix}`,
        description: "Meets Tuesdays",
        capacity: 8,
        isOpen: false,
      },
      {
        year: "2030-2031",
        semester: FROM,
        name: `Beta ${suffix}`,
        description: null,
        capacity: null,
        isOpen: true,
      },
    ]);
  }

  const groupsOf = (term: string) =>
    db.select().from(kinGroups).where(eq(kinGroups.semester, term));

  const carryRows = () =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "kin_group.carry_forward"),
          eq(auditLog.targetLabel, TO),
        ),
      );

  beforeAll(async () => {
    setSystemTime(NOW);
    officer = await makeUser("officer", "ADMIN");
    member = await makeUser("member", "MEMBER");
  }, SLOW);

  afterAll(async () => {
    setSystemTime();
    await clearGroups();
    await db.delete(users).where(inArray(users.id, userIds));
  }, SLOW);

  it(
    "copies name, description, seats and openness, and seats nobody",
    async () => {
      await seedLastSemester();
      const [alpha] = await db
        .select()
        .from(kinGroups)
        .where(
          and(
            eq(kinGroups.semester, FROM),
            eq(kinGroups.name, `Alpha ${suffix}`),
          ),
        );
      await db.insert(kinMemberships).values({
        userId: member.id,
        semester: FROM,
        groupId: alpha!.id,
      });

      const result = await callerFor(officer).mentorship.carryForwardGroups();
      expect(result).toEqual({ from: FROM, to: TO, created: 2, skipped: 0 });

      const copied = await groupsOf(TO);
      expect(
        copied
          .map((group) => ({
            name: group.name,
            description: group.description,
            capacity: group.capacity,
            isOpen: group.isOpen,
            year: group.year,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual([
        {
          name: `Alpha ${suffix}`,
          description: "Meets Tuesdays",
          capacity: 8,
          isOpen: false,
          year: "2031-2032",
        },
        {
          name: `Beta ${suffix}`,
          description: null,
          capacity: null,
          isOpen: true,
          year: "2031-2032",
        },
      ]);
      // Members are not moved: nobody sits in a copied group.
      const seats = await db
        .select()
        .from(kinMemberships)
        .where(
          inArray(
            kinMemberships.groupId,
            copied.map((group) => group.id),
          ),
        );
      expect(seats).toEqual([]);
      // Last semester is left as history.
      expect(await groupsOf(FROM)).toHaveLength(2);
      expect(await carryRows()).toHaveLength(1);
      await db
        .delete(kinMemberships)
        .where(eq(kinMemberships.userId, member.id));
    },
    SLOW,
  );

  it(
    "does nothing the second time, and says what it skipped",
    async () => {
      await seedLastSemester();
      const first = await callerFor(officer).mentorship.carryForwardGroups();
      const second = await callerFor(officer).mentorship.carryForwardGroups();

      expect(first.created).toBe(2);
      expect(second).toEqual({ from: FROM, to: TO, created: 0, skipped: 2 });
      expect(await groupsOf(TO)).toHaveLength(2);
      // Only the call that created something is in the log.
      expect(await carryRows()).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "leaves a group alone when its name is already here, in any letter case",
    async () => {
      await seedLastSemester();
      const [existing] = await db
        .insert(kinGroups)
        .values({
          year: "2031-2032",
          semester: TO,
          name: `ALPHA ${suffix}`,
          description: "Made by hand",
          capacity: 3,
          isOpen: true,
        })
        .returning();

      const result = await callerFor(officer).mentorship.carryForwardGroups();
      expect(result).toMatchObject({ created: 1, skipped: 1 });

      const copied = await groupsOf(TO);
      expect(copied).toHaveLength(2);
      const kept = copied.find((group) => group.id === existing!.id);
      expect(kept).toMatchObject({
        description: "Made by hand",
        capacity: 3,
      });
    },
    SLOW,
  );

  it(
    "survives a double submit: two simultaneous calls create each group once",
    async () => {
      await seedLastSemester();
      const officerCaller = callerFor(officer);
      const [one, two] = await Promise.all([
        officerCaller.mentorship.carryForwardGroups(),
        officerCaller.mentorship.carryForwardGroups(),
      ]);

      expect(one.created + two.created).toBe(2);
      expect(one.created + one.skipped).toBe(2);
      expect(two.created + two.skipped).toBe(2);
      const copied = await groupsOf(TO);
      expect(copied.map((group) => group.name).sort()).toEqual([
        `Alpha ${suffix}`,
        `Beta ${suffix}`,
      ]);
      expect(await carryRows()).toHaveLength(1);
    },
    SLOW,
  );

  it(
    "has nothing to copy when last semester had no groups",
    async () => {
      await clearGroups();
      expect(await callerFor(officer).mentorship.carryForwardGroups()).toEqual({
        from: FROM,
        to: TO,
        created: 0,
        skipped: 0,
      });
      expect(await carryRows()).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "is for officers only",
    async () => {
      await seedLastSemester();
      expect(
        await errorCode(callerFor(member).mentorship.carryForwardGroups()),
      ).toBe("FORBIDDEN");
      const signedOut = createCaller({
        db,
        session: null,
        headers: new Headers(),
      });
      expect(await errorCode(signedOut.mentorship.carryForwardGroups())).toBe(
        "UNAUTHORIZED",
      );
      expect(await groupsOf(TO)).toHaveLength(0);
    },
    SLOW,
  );
});
