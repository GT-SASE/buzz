import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
const { COMMITTEE_CYCLE_CLOSES_AT } =
  await import("../packages/api/src/committee-cycle");
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

function memberCtx(db: unknown): Ctx {
  return {
    db,
    session: {
      user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

function adminCtx(db: unknown): Ctx {
  return {
    db,
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

const treasuryInput = {
  discordHandle: "samanyu",
  wantsEvents: false,
  wantsMarketing: false,
  wantsTreasury: true,
  treasuryWhy: "I want to learn how SASE handles money.",
};

beforeEach(() => {
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
});

describe("committee.submit", () => {
  it("inserts a first-time treasury application", async () => {
    const inserted: unknown[] = [];
    const db = {
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

  it("refuses to rewrite a row already in review", async () => {
    const db = {
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
    vi.useFakeTimers();
    vi.setSystemTime(COMMITTEE_CYCLE_CLOSES_AT);

    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).committee.submit(treasuryInput),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(error.message).toMatch(/closed/i);
  });
});

describe("committee.withdraw", () => {
  it("marks a submitted row withdrawn", async () => {
    const sets: unknown[] = [];
    const db = {
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

describe("committee.setStatus", () => {
  it("lets an officer move a row to interviewing", async () => {
    const sets: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: "app-1" }]),
        }),
      }),
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

    await createCaller(adminCtx(db)).committee.setStatus({
      id: "app-1",
      status: "interviewing",
    });

    expect(sets[0]).toMatchObject({ status: "interviewing" });
  });
});
