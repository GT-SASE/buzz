import { beforeEach, describe, expect, it, mock } from "bun:test";
import { stubEnv, unstubAllEnvs } from "../helpers/env";
import {
  auditRows,
  ledgerRows,
  resetWrites,
  withMemoryAudit,
} from "../helpers/audit";
import { resetRateLimits, withMemoryLimiter } from "../helpers/rate-limit";

mock.module("../../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../../packages/api/src/root");
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

beforeEach(() => {
  resetRateLimits();
  resetWrites();
});

/**
 * A transaction whose reads answer in the order the router asks them, and
 * whose writes are only counted. `where()` serves both a bare `await` and a
 * following `.for()` or `.returning()`.
 */
function awardingDb(reads: unknown[][]) {
  const answers = [...reads];
  const sets: Record<string, unknown>[] = [];
  const next = () => Promise.resolve(answers.shift() ?? []);
  const select = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      for: () => next(),
      then: (
        onFulfilled?: (value: unknown[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => next().then(onFulfilled, onRejected),
    };
    return chain;
  };
  const db = {
    select,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        const done = {
          returning: () => Promise.resolve([values]),
          then: (
            onFulfilled?: (value: undefined) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => Promise.resolve(undefined).then(onFulfilled, onRejected),
        };
        return { where: () => done };
      },
    }),
    transaction: (run: (tx: unknown) => Promise<unknown>) => run(db),
  };
  return { db, sets };
}

describe("mentorship.list", () => {
  it("refuses a MEMBER session before reading", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).mentorship.list(),
    );
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("mentorship.awardPoints", () => {
  it("refuses a MEMBER session before writing", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).mentorship.awardPoints({
        userId: "member-1",
        points: 5,
      }),
    );
    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("mentorship.awardPoints writes", () => {
  it("adds the points to the ledger and logs the total before and after", async () => {
    const { db } = awardingDb([
      [{ points: 12 }],
      [],
      [{ email: "member-2@gatech.edu" }],
    ]);

    await createCaller(adminCtx(db)).mentorship.awardPoints({
      userId: "member-2",
      points: 5,
    });

    expect(ledgerRows).toEqual([
      {
        userId: "member-2",
        delta: 5,
        reason: "KIN points awarded by an officer",
        source: "kin_award",
        eventId: null,
        actedByUserId: "officer-1",
      },
    ]);
    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "mentorship.award_points",
        targetType: "member",
        targetId: "member-2",
        targetLabel: "member-2@gatech.edu",
        before: { points: 12 },
        after: { points: 17 },
      },
    ]);
  });

  it("writes nothing for someone who has not signed up", async () => {
    const { db } = awardingDb([[]]);

    const error = await rejection(
      createCaller(adminCtx(db)).mentorship.awardPoints({
        userId: "nobody",
        points: 5,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(auditRows).toEqual([]);
    expect(ledgerRows).toEqual([]);
  });
});

describe("mentorship.awardGroupPoints writes", () => {
  it("gives every member of the group a ledger row and logs one entry for the group", async () => {
    const { db } = awardingDb([
      [{ year: "2026-2027", name: "Hive" }],
      [
        { userId: "member-1", semester: "fall-2026", points: 0 },
        { userId: "member-2", semester: "fall-2026", points: 4 },
      ],
      [
        { userId: "member-1", points: 0 },
        { userId: "member-2", points: 4 },
      ],
    ]);

    const result = await createCaller(adminCtx(db)).mentorship.awardGroupPoints(
      { groupId: "group-1", points: 3 },
    );

    expect(result).toEqual({ awarded: 2 });
    expect(ledgerRows).toEqual(
      ["member-1", "member-2"].map((userId) => ({
        userId,
        delta: 3,
        reason: "KIN group points: Hive",
        source: "kin_group_award",
        eventId: null,
        actedByUserId: "officer-1",
      })),
    );
    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "mentorship.award_group_points",
        targetType: "kin_group",
        targetId: "group-1",
        targetLabel: "Hive",
        before: null,
        after: { points: 3, members: 2 },
      },
    ]);
  });

  it("counts only the members whose yearly total moved when a seat has no signup for the year", async () => {
    const { db } = awardingDb([
      [{ year: "2026-2027", name: "Hive" }],
      [
        { userId: "member-1", semester: "fall-2026", points: 0 },
        { userId: "member-2", semester: "fall-2026", points: 4 },
      ],
      [{ userId: "member-1", points: 0 }],
    ]);

    await createCaller(adminCtx(db)).mentorship.awardGroupPoints({
      groupId: "group-1",
      points: 3,
    });

    expect(ledgerRows.map((row) => row.userId)).toEqual(["member-1"]);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.after).toEqual({ points: 3, members: 1 });
  });

  it("writes nothing for an empty group", async () => {
    const { db } = awardingDb([[{ year: "2026-2027", name: "Hive" }], []]);

    const error = await rejection(
      createCaller(adminCtx(db)).mentorship.awardGroupPoints({
        groupId: "group-1",
        points: 3,
      }),
    );

    expect(error.code).toBe("BAD_REQUEST");
    expect(auditRows).toEqual([]);
    expect(ledgerRows).toEqual([]);
  });
});

describe("mentorship.expressInterest", () => {
  it("writes an interested mentee for a first-time signup", async () => {
    const inserted: unknown[] = [];
    const db = {
      query: {
        mentorshipEnrollments: {
          findFirst: () => Promise.resolve(undefined),
        },
        kinMemberships: {
          findFirst: () => Promise.resolve(undefined),
        },
      },
      insert: () => ({
        values: (row: unknown) => ({
          onConflictDoUpdate: () => ({
            returning: () => {
              inserted.push(row);
              return Promise.resolve([row]);
            },
          }),
        }),
      }),
    };

    const result = await createCaller(memberCtx(db)).mentorship.expressInterest(
      {
        role: "mentee",
        note: "CS, first year",
      },
    );

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: "member-1",
      role: "mentee",
      status: "interested",
      note: "CS, first year",
    });
    expect(result).toMatchObject({ role: "mentee", status: "interested" });
  });

  it("refuses to change role while in a group this semester", async () => {
    const db = {
      query: {
        mentorshipEnrollments: {
          findFirst: () =>
            Promise.resolve({
              userId: "member-1",
              status: "enrolled",
            }),
        },
        kinMemberships: {
          findFirst: () =>
            Promise.resolve({ userId: "member-1", groupId: "g1" }),
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
      createCaller(memberCtx(db)).mentorship.expressInterest({
        role: "mentor",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("mentorship.setStatus", () => {
  it("refuses a MEMBER session before writing", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).mentorship.setStatus({
        userId: "member-1",
        status: "enrolled",
      }),
    );
    expect(error.code).toBe("FORBIDDEN");
  });

  it("lets an officer enroll someone who signed up", async () => {
    const sets: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ userId: "member-1" }]),
        }),
      }),
      update: () => ({
        set: (row: Record<string, unknown>) => {
          sets.push(row);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve([{ userId: "member-1", ...row }]),
            }),
          };
        },
      }),
    };
    Object.assign(db, {
      transaction: (run: (tx: typeof db) => Promise<unknown>) => run(db),
    });

    await createCaller(adminCtx(db)).mentorship.setStatus({
      userId: "member-1",
      status: "enrolled",
    });

    expect(sets[0]).toMatchObject({ status: "enrolled" });
    expect((sets[0] as { enrolledAt: Date }).enrolledAt).toBeInstanceOf(Date);
  });
});

describe("kin group officer procedures", () => {
  const cases = {
    createGroup: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.createGroup({
        name: "Hive",
        capacity: null,
        isOpen: true,
      }),
    updateGroup: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.updateGroup({
        id: "g1",
        name: "Hive",
        capacity: null,
        isOpen: true,
      }),
    deleteGroup: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.deleteGroup({ id: "g1" }),
    assignGroup: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.assignGroup({ userId: "member-2", groupId: "g1" }),
    awardGroupPoints: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.awardGroupPoints({ groupId: "g1", points: 5 }),
    semesters: (caller: ReturnType<typeof createCaller>) =>
      caller.mentorship.semesters(),
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
