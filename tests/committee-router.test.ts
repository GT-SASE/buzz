import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
  vi,
} from "bun:test";
import { stubEnv, unstubAllEnvs } from "./helpers/env";
import { auditRows, resetWrites, withMemoryAudit } from "./helpers/audit";
import { resetRateLimits, withMemoryLimiter } from "./helpers/rate-limit";

mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

function memberCtx(db: unknown): Ctx {
  return {
    db: withMemoryLimiter(db),
    session: {
      user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

function adminCtx(db: unknown): Ctx {
  return {
    db: withMemoryAudit(withMemoryLimiter(db)),
    session: {
      user: { id: "officer-1", role: "ADMIN", email: "officer@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code: string; message: string };
  }
  throw new Error("expected the procedure to reject, but it resolved");
}

const unreachableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `db.${String(property)} was reached; the caller should have been refused first`,
      );
    },
  },
);

const CLOSES_AT = new Date("2026-09-10T04:00:00.000Z");
const ALL = ["events", "marketing", "treasury", "website"];

/** The `select().from().where()` chain the router uses to read a cycle. */
function cycleSelect(rows: object[]) {
  const stamped = rows.map((row) => ({ createdAt: new Date(0), ...row }));
  return () => ({
    from: () => ({
      where: () => Promise.resolve(stamped),
    }),
  });
}

const treasuryInput = {
  discordHandle: "samanyu",
  wantsEvents: false,
  wantsMarketing: false,
  wantsTreasury: true,
  treasuryWhy: "I want to learn how SASE handles money.",
};

beforeEach(() => {
  resetWrites();
  resetRateLimits();
  vi.useRealTimers();
});

describe("committee.list", () => {
  it("refuses a MEMBER session before reading", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).committee.list(),
    );
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("committee.setStatus", () => {
  it("refuses a MEMBER session before writing", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).committee.setStatus({
        id: "app-1",
        status: "interviewing",
      }),
    );
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("committee.mine", () => {
  it("omits officer notes from the member payload", async () => {
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ALL },
      ]),
      query: {
        committeeApplications: {
          findFirst: () =>
            Promise.resolve({
              id: "app-1",
              userId: "member-1",
              discordHandle: "samanyu",
              status: "submitted",
              officerNotes: "do not leak this",
            }),
        },
      },
    };

    const result = await createCaller(memberCtx(db)).committee.mine();
    expect(result.application).toMatchObject({
      id: "app-1",
      discordHandle: "samanyu",
    });
    expect(result.application).not.toHaveProperty("officerNotes");
  });

  it("reports no cycle when officers have not opened one", async () => {
    const db = {
      select: cycleSelect([]),
      query: {
        committeeApplications: { findFirst: () => Promise.resolve(undefined) },
      },
    };
    const result = await createCaller(memberCtx(db)).committee.mine();
    expect(result).toMatchObject({ cycle: null, closesAt: null, open: false });
  });
});

describe("committee.submit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setSystemTime(CLOSES_AT.getTime() - 24 * 60 * 60 * 1000);
  });

  it("inserts a first-time treasury application", async () => {
    const inserted: unknown[] = [];
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ALL },
      ]),
      query: {
        committeeApplications: {
          findFirst: () => Promise.resolve(undefined),
        },
      },
      insert: () => ({
        values: (row: unknown) => ({
          returning: () => {
            inserted.push(row);
            return Promise.resolve([{ id: "app-1", ...(row as object) }]);
          },
        }),
      }),
    };

    const result = await createCaller(memberCtx(db)).committee.submit(
      treasuryInput,
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: "member-1",
      cycle: "fall-2026",
      status: "submitted",
      wantsTreasury: true,
      wantsEvents: false,
      treasuryWhy: treasuryInput.treasuryWhy,
    });
    expect(result).toMatchObject({ wantsTreasury: true, status: "submitted" });
  });

  it("refuses a committee the cycle is not taking", async () => {
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ["website"] },
      ]),
      query: {
        committeeApplications: { findFirst: () => Promise.resolve(undefined) },
      },
      insert: () => {
        throw new Error("must not insert");
      },
    };

    const error = await rejection(
      createCaller(memberCtx(db)).committee.submit(treasuryInput),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("refuses to rewrite a row already in review", async () => {
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ALL },
      ]),
      query: {
        committeeApplications: {
          findFirst: () =>
            Promise.resolve({
              id: "app-1",
              status: "interviewing",
            }),
        },
      },
      insert: () => {
        throw new Error("must not insert");
      },
      update: () => {
        throw new Error("must not update");
      },
    };

    const error = await rejection(
      createCaller(memberCtx(db)).committee.submit(treasuryInput),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("refuses after the cycle closes", async () => {
    setSystemTime(CLOSES_AT);
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ALL },
      ]),
    };

    const error = await rejection(
      createCaller(memberCtx(db)).committee.submit(treasuryInput),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toMatch(/closed/i);
  });

  it("refuses when no cycle is open this semester", async () => {
    const error = await rejection(
      createCaller(memberCtx({ select: cycleSelect([]) })).committee.submit(
        treasuryInput,
      ),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("committee.withdraw", () => {
  it("marks a submitted row withdrawn", async () => {
    const sets: unknown[] = [];
    const db = {
      select: cycleSelect([
        { id: "fall-2026", closesAt: CLOSES_AT, committees: ALL },
      ]),
      query: {
        committeeApplications: {
          findFirst: () =>
            Promise.resolve({ id: "app-1", status: "submitted" }),
        },
      },
      update: () => ({
        set: (row: Record<string, unknown>) => {
          sets.push(row);
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: "app-1", ...row }]),
            }),
          };
        },
      }),
    };

    await createCaller(memberCtx(db)).committee.withdraw();
    expect(sets[0]).toMatchObject({ status: "withdrawn" });
  });
});

/** `select().from().innerJoin().where().for()`: the locked application row. */
function applicationDb(existing: object | undefined) {
  const sets: Record<string, unknown>[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    for: () => Promise.resolve(existing ? [existing] : []),
  };
  return {
    sets,
    db: {
      select: () => chain,
      update: () => ({
        set: (row: Record<string, unknown>) => {
          sets.push(row);
          return {
            where: () => ({
              returning: () => Promise.resolve([{ id: "app-1", ...row }]),
            }),
          };
        },
      }),
    },
  };
}

const SUBMITTED = {
  id: "app-1",
  status: "submitted",
  cycle: "fall-2026",
  email: "applicant@gatech.edu",
};

describe("committee.setStatus", () => {
  it("lets an officer move a row to interviewing", async () => {
    const { db, sets } = applicationDb(SUBMITTED);

    await createCaller(adminCtx(db)).committee.setStatus({
      id: "app-1",
      status: "interviewing",
    });

    expect(sets[0]).toMatchObject({ status: "interviewing" });
  });

  it("logs the decision with the status it replaced", async () => {
    const { db } = applicationDb(SUBMITTED);

    await createCaller(adminCtx(db)).committee.setStatus({
      id: "app-1",
      status: "accepted",
    });

    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "committee.set_status",
        targetType: "application",
        targetId: "app-1",
        targetLabel: "applicant@gatech.edu",
        before: { status: "submitted", cycle: "fall-2026" },
        after: { status: "accepted", cycle: "fall-2026" },
      },
    ]);
  });

  it("logs nothing when the status is the one it already had", async () => {
    const { db } = applicationDb({ ...SUBMITTED, status: "accepted" });

    await createCaller(adminCtx(db)).committee.setStatus({
      id: "app-1",
      status: "accepted",
    });

    expect(auditRows).toEqual([]);
  });

  it("is NOT_FOUND, and logs nothing, for an application that is not there", async () => {
    const { db } = applicationDb(undefined);

    const error = await rejection(
      createCaller(adminCtx(db)).committee.setStatus({
        id: "missing",
        status: "accepted",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(auditRows).toEqual([]);
  });
});

describe("committee.exportCycle", () => {
  it("logs the export with its cycle and row count", async () => {
    const chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve([{ name: "Ada" }, { name: "Grace" }]),
    };

    const result = await createCaller(
      adminCtx({ select: () => chain }),
    ).committee.exportCycle({ cycle: "fall-2026" });

    expect(result.rows).toHaveLength(2);
    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "export.committee",
        targetType: "cycle",
        targetId: "fall-2026",
        targetLabel: null,
        before: null,
        after: { rows: 2, truncated: false },
      },
    ]);
  });
});

describe("committee cycle officer procedures", () => {
  const cases = {
    cycles: (caller: ReturnType<typeof createCaller>) =>
      caller.committee.cycles(),
    openCycle: (caller: ReturnType<typeof createCaller>) =>
      caller.committee.openCycle({ closesAt: new Date("2099-01-01") }),
    setCycleCloses: (caller: ReturnType<typeof createCaller>) =>
      caller.committee.setCycleCloses({
        id: "fall-2026",
        closesAt: new Date(),
      }),
    exportCycle: (caller: ReturnType<typeof createCaller>) =>
      caller.committee.exportCycle({ cycle: "fall-2026" }),
  };

  for (const [name, call] of Object.entries(cases)) {
    it(`${name} refuses a MEMBER session before touching the database`, async () => {
      const error = await rejection(
        call(createCaller(memberCtx(unreachableDb))),
      );
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});
