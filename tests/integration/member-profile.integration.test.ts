import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

mock.module("../../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { auditLog, db, memberProfiles, users } =
  await import("../../packages/db/src/index");
const { createCaller } = await import("../../packages/api/src/root");
const { and, eq, inArray } =
  await import("../../packages/db/node_modules/drizzle-orm/index.js");

const SLOW = 60_000;

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

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe.skipIf(!process.env.DATABASE_URL)("member profile", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let officer: TestUser;
  let member: TestUser;
  let other: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `mp-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role };
  }

  const auditFor = (userId: string) =>
    db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "member.set_graduation_year"),
          eq(auditLog.targetId, userId),
        ),
      );

  beforeAll(async () => {
    officer = await makeUser("officer", "ADMIN");
    member = await makeUser("member", "MEMBER");
    other = await makeUser("other", "MEMBER");
  }, SLOW);

  afterAll(async () => {
    await db.delete(auditLog).where(inArray(auditLog.targetId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }, SLOW);

  it(
    "lets a member set, change and clear their own graduation year",
    async () => {
      const caller = callerFor(member);
      expect(await caller.member.profile()).toEqual({ graduationYear: null });

      expect(await caller.member.setProfile({ graduationYear: 2028 })).toEqual({
        graduationYear: 2028,
      });
      expect(await caller.member.profile()).toEqual({ graduationYear: 2028 });

      await caller.member.setProfile({ graduationYear: 2029 });
      expect(await caller.member.profile()).toEqual({ graduationYear: 2029 });

      // Empty means unset.
      await caller.member.setProfile({ graduationYear: null });
      expect(await caller.member.profile()).toEqual({ graduationYear: null });
      // Their own edit is theirs to make, so it is not an officer action.
      expect(await auditFor(member.id)).toHaveLength(0);
    },
    SLOW,
  );

  it(
    "refuses a year outside 2000 to 2100, in zod and in the table",
    async () => {
      const caller = callerFor(member);
      for (const graduationYear of [1999, 2101, 2028.5]) {
        expect(
          await errorCode(caller.member.setProfile({ graduationYear })),
        ).toBe("BAD_REQUEST");
      }
      expect(
        await errorCode(
          Promise.resolve(
            db
              .insert(memberProfiles)
              .values({ userId: other.id, graduationYear: 1999 })
              .then(() => undefined),
          ),
        ),
      ).not.toBe("NO_ERROR");
    },
    SLOW,
  );

  it(
    "lets an officer edit any member's year and logs it",
    async () => {
      const staff = callerFor(officer);
      await staff.member.setGraduationYear({
        userId: other.id,
        graduationYear: 2027,
      });
      const years = await staff.member.graduationYears({
        userIds: [other.id, member.id],
      });
      expect(years[other.id]).toBe(2027);
      expect(years[member.id]).toBeUndefined();

      await staff.member.setGraduationYear({
        userId: other.id,
        graduationYear: 2028,
      });
      // The same year again changes nothing and logs nothing.
      await staff.member.setGraduationYear({
        userId: other.id,
        graduationYear: 2028,
      });
      await staff.member.setGraduationYear({
        userId: other.id,
        graduationYear: null,
      });

      const rows = (await auditFor(other.id)).sort(
        (a, b) => a.at.getTime() - b.at.getTime(),
      );
      expect(rows.map((row) => [row.before, row.after])).toEqual([
        [{ graduationYear: null }, { graduationYear: 2027 }],
        [{ graduationYear: 2027 }, { graduationYear: 2028 }],
        [{ graduationYear: 2028 }, { graduationYear: null }],
      ]);
      expect(rows[0]).toMatchObject({
        actorId: officer.id,
        targetType: "member",
        targetLabel: other.email,
      });
    },
    SLOW,
  );

  it(
    "keeps a member from editing anyone else, or reading the roster's years",
    async () => {
      const caller = callerFor(member);
      expect(
        await errorCode(
          caller.member.setGraduationYear({
            userId: other.id,
            graduationYear: 2030,
          }),
        ),
      ).toBe("FORBIDDEN");
      expect(
        await errorCode(caller.member.graduationYears({ userIds: [other.id] })),
      ).toBe("FORBIDDEN");
      expect(
        await errorCode(
          callerFor(officer).member.setGraduationYear({
            userId: `nobody-${suffix}`,
            graduationYear: 2030,
          }),
        ),
      ).toBe("NOT_FOUND");
    },
    SLOW,
  );
});

/**
 * A preview build runs against the production database before migration 0016
 * has: the profile table is not there yet, and every read has to cope.
 */
describe("member profile before its migration", () => {
  const missing = Object.assign(
    new Error('relation "buzz_member_profile" does not exist'),
    { code: "42P01" },
  );
  const noTable = {
    select: () => ({
      from: () => ({ where: () => Promise.reject(missing) }),
    }),
  } as unknown as typeof db;
  const member: TestUser = {
    id: "mp-fallback",
    email: "fallback@vitest.local",
    role: "MEMBER",
  };

  it("reads as unset instead of failing", async () => {
    expect(await callerFor(member, noTable).member.profile()).toEqual({
      graduationYear: null,
    });
    expect(
      await callerFor(
        { ...member, role: "ADMIN" },
        noTable,
      ).member.graduationYears({ userIds: ["a", "b"] }),
    ).toEqual({});
  });
});
