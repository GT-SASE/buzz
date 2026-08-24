import { describe, expect, it, vi } from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
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

describe("mentorship.expressInterest", () => {
  it("writes an interested mentee for a first-time signup", async () => {
    const inserted: unknown[] = [];
    const db = {
      query: {
        mentorshipEnrollments: {
          findFirst: () => Promise.resolve(undefined),
        },
      },
      insert: () => ({
        values: (row: unknown) => ({
          returning: () => {
            inserted.push(row);
            return Promise.resolve([row]);
          },
        }),
      }),
    };

    const result = await createCaller(memberCtx(db)).mentorship.expressInterest({
      role: "mentee",
      note: "CS, first year",
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      userId: "member-1",
      role: "mentee",
      status: "interested",
      note: "CS, first year",
    });
    expect(result).toMatchObject({ role: "mentee", status: "interested" });
  });

  it("refuses to rewrite an enrolled row", async () => {
    const db = {
      query: {
        mentorshipEnrollments: {
          findFirst: () =>
            Promise.resolve({
              userId: "member-1",
              status: "enrolled",
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
      createCaller(memberCtx(db)).mentorship.expressInterest({
        role: "mentor",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

describe("mentorship.setStatus", () => {
  it("lets an officer enroll someone who signed up", async () => {
    const sets: unknown[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ userId: "member-1" }]),
        }),
      }),
      update: () => ({
        set: (row: unknown) => {
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

    await createCaller(adminCtx(db)).mentorship.setStatus({
      userId: "member-1",
      status: "enrolled",
    });

    expect(sets[0]).toMatchObject({ status: "enrolled" });
    expect((sets[0] as { enrolledAt: Date }).enrolledAt).toBeInstanceOf(Date);
  });
});
