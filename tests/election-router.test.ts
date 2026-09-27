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
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];
type Caller = ReturnType<typeof createCaller>;

function ctxFor(session: unknown): Ctx {
  return { db: unreachableDb, session, headers: new Headers() } as Ctx;
}

const member = {
  user: { id: "member-1", role: "MEMBER", email: "member@gatech.edu" },
  expires: "2099-01-01T00:00:00.000Z",
};

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

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { code: string };
  }
  throw new Error("expected the procedure to reject, but it resolved");
}

beforeEach(() => resetRateLimits());

const officerOnly: Record<string, (caller: Caller) => Promise<unknown>> = {
  list: (caller) => caller.election.list(),
  years: (caller) => caller.election.years(),
  create: (caller) =>
    caller.election.create({ title: "Board", positions: ["President"] }),
  setCandidateStatus: (caller) =>
    caller.election.setCandidateStatus({
      candidateId: "c1",
      status: "approved",
    }),
  setPhase: (caller) =>
    caller.election.setPhase({ electionId: "e1", phase: "voting" }),
  delete: (caller) => caller.election.delete({ electionId: "e1" }),
};

describe("election officer procedures", () => {
  for (const [name, call] of Object.entries(officerOnly)) {
    it(`${name} refuses a MEMBER session before touching the database`, async () => {
      const error = await rejection(call(createCaller(ctxFor(member))));
      expect(error.code).toBe("FORBIDDEN");
    });
  }
});

const memberCalls: Record<string, (caller: Caller) => Promise<unknown>> = {
  current: (caller) => caller.election.current(),
  nominate: (caller) =>
    caller.election.nominate({ positionId: "p1", statement: "Vote for me" }),
  withdrawNomination: (caller) =>
    caller.election.withdrawNomination({ candidateId: "c1" }),
  vote: (caller) =>
    caller.election.vote({ positionId: "p1", candidateId: "c1" }),
};

describe("election member procedures", () => {
  for (const [name, call] of Object.entries(memberCalls)) {
    it(`${name} refuses a signed-out caller`, async () => {
      const error = await rejection(call(createCaller(ctxFor(null))));
      expect(error.code).toBe("UNAUTHORIZED");
    });
  }

  it("rejects an empty nomination statement before reading", async () => {
    const error = await rejection(
      createCaller(ctxFor(member)).election.nominate({
        positionId: "p1",
        statement: "   ",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});
