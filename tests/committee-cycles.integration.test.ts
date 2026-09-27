import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { db, committeeApplications, committeeCycles, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { eq, inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

/** A semester no real cycle will ever use, so the suite owns its row. */
const CYCLE = "spring-2091";
const NOW = new Date("2091-02-01T17:00:00.000Z");
const CLOSES = new Date("2091-02-15T05:00:00.000Z");

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

const treasury = {
  discordHandle: "vitest",
  wantsEvents: false,
  wantsMarketing: false,
  wantsTreasury: true,
  treasuryWhy: "Budgets.",
};

describe.skipIf(!process.env.DATABASE_URL)("committee cycles", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let officer: TestUser;
  let member: TestUser;

  async function makeUser(label: string, role: TestUser["role"]) {
    const id = `cc-${label}-${suffix}`;
    const email = `${id}@vitest.local`;
    await db.insert(users).values({ id, email, role, name: label });
    userIds.push(id);
    return { id, email, role };
  }

  beforeAll(async () => {
    resetRateLimits();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await db.delete(committeeCycles).where(eq(committeeCycles.id, CYCLE));
    officer = await makeUser("officer", "ADMIN");
    member = await makeUser("member", "MEMBER");
  });

  afterAll(async () => {
    vi.useRealTimers();
    await db
      .delete(committeeApplications)
      .where(inArray(committeeApplications.userId, userIds));
    await db.delete(committeeCycles).where(eq(committeeCycles.id, CYCLE));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("refuses applications before officers open the semester", async () => {
    expect(await callerFor(member).committee.mine()).toMatchObject({
      cycle: null,
      label: "Spring 2091",
      open: false,
    });
    expect(await errorCode(callerFor(member).committee.submit(treasury))).toBe(
      "BAD_REQUEST",
    );
  });

  it("keeps opening cycles to officers and future dates", async () => {
    expect(
      await errorCode(
        callerFor(member).committee.openCycle({ closesAt: CLOSES }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await errorCode(
        callerFor(officer).committee.openCycle({
          closesAt: new Date(NOW.getTime() - 1000),
        }),
      ),
    ).toBe("BAD_REQUEST");
  });

  it("opens this semester once, then takes applications", async () => {
    const opened = await callerFor(officer).committee.openCycle({
      closesAt: CLOSES,
    });
    expect(opened).toMatchObject({ id: CYCLE, createdById: officer.id });
    expect(
      await errorCode(
        callerFor(officer).committee.openCycle({ closesAt: CLOSES }),
      ),
    ).toBe("CONFLICT");

    expect(await callerFor(member).committee.mine()).toMatchObject({
      cycle: CYCLE,
      open: true,
    });
    const applied = await callerFor(member).committee.submit(treasury);
    expect(applied).toMatchObject({ cycle: CYCLE, status: "submitted" });

    const listed = await callerFor(officer).committee.list({ cycle: CYCLE });
    expect(listed.map((row) => row.userId)).toContain(member.id);

    const { current, cycles } = await callerFor(officer).committee.cycles();
    expect(current).toBe(CYCLE);
    expect(cycles.find((cycle) => cycle.id === CYCLE)).toMatchObject({
      open: true,
      applications: 1,
    });
  });

  it("closes early when an officer moves the date to now", async () => {
    await callerFor(officer).committee.setCycleCloses({
      id: CYCLE,
      closesAt: new Date(),
    });
    expect(await callerFor(member).committee.mine()).toMatchObject({
      cycle: CYCLE,
      open: false,
    });
    expect(await errorCode(callerFor(member).committee.submit(treasury))).toBe(
      "BAD_REQUEST",
    );
    expect(
      await errorCode(
        callerFor(officer).committee.setCycleCloses({
          id: "fall-2092",
          closesAt: CLOSES,
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});
