import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
const {
  EXPORT_ATTENDANCE_LIMIT,
  rateLimitBucketCount,
  resetRateLimits,
  takeToken,
} = await import("../packages/api/src/rate-limit");
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

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

const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
afterAll(() => consoleLog.mockRestore());

beforeEach(() => resetRateLimits());

type AttendanceRow = {
  userId: string;
  name: string | null;
  email: string;
  method: string;
  pointsEarned: number;
  checkedInAt: Date;
};

function attendanceRow(index: number): AttendanceRow {
  return {
    userId: `member-${index}`,
    name: `Member ${index}`,
    email: `member${index}@gatech.edu`,
    method: index % 2 === 0 ? "code" : "manual",
    pointsEarned: 7,
    checkedInAt: new Date("2026-09-01T18:30:00.000Z"),
  };
}

function attendanceDb(
  rows: AttendanceRow[],
  event: { id: string } | undefined,
) {
  const limits: number[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (value: number) => {
      limits.push(value);
      return Promise.resolve(rows);
    },
  };
  return {
    limits,
    db: {
      query: { events: { findFirst: () => Promise.resolve(event) } },
      select: () => chain,
    },
  };
}

describe("event.exportAttendance", () => {
  it("returns the roster and reports it as untruncated below the cap", async () => {
    const { db, limits } = attendanceDb([attendanceRow(1), attendanceRow(2)], {
      id: "event-1",
    });
    const result = await createCaller(adminCtx(db)).event.exportAttendance({
      id: "event-1",
    });

    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(limits).toEqual([5000]);
  });

  it("flags truncation once the query comes back full", async () => {
    const rows = Array.from({ length: 5000 }, (_unused, index) =>
      attendanceRow(index),
    );
    const { db } = attendanceDb(rows, { id: "event-1" });
    const result = await createCaller(adminCtx(db)).event.exportAttendance({
      id: "event-1",
    });

    expect(result.truncated).toBe(true);
  });

  it("is NOT_FOUND for an event id that does not exist", async () => {
    const { db } = attendanceDb([], undefined);
    const error = await rejection(
      createCaller(adminCtx(db)).event.exportAttendance({ id: "missing" }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("refuses a MEMBER session before reading anything", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).event.exportAttendance({
        id: "event-1",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("rate limits repeat exports, the same as the roster export", async () => {
    const { db } = attendanceDb([attendanceRow(1)], { id: "event-1" });
    const caller = createCaller(adminCtx(db));

    for (let call = 0; call < EXPORT_ATTENDANCE_LIMIT.limit; call++) {
      await caller.event.exportAttendance({ id: "event-1" });
    }

    const error = await rejection(
      caller.event.exportAttendance({ id: "event-1" }),
    );
    expect(error.code).toBe("TOO_MANY_REQUESTS");
  });
});

function updateReturningDb(returned: Record<string, unknown>[]) {
  const sets: Record<string, unknown>[] = [];
  return {
    sets,
    db: {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          sets.push(values);
          return {
            where: () => ({ returning: () => Promise.resolve(returned) }),
          };
        },
      }),
    },
  };
}

describe("event.setCheckInEnabled", () => {
  it("closes the door", async () => {
    const { db, sets } = updateReturningDb([
      { id: "event-1", checkInEnabled: false },
    ]);
    const result = await createCaller(adminCtx(db)).event.setCheckInEnabled({
      id: "event-1",
      enabled: false,
    });

    expect(sets).toEqual([{ checkInEnabled: false }]);
    expect(result.checkInEnabled).toBe(false);
  });

  it("opens it again", async () => {
    const { db, sets } = updateReturningDb([
      { id: "event-1", checkInEnabled: true },
    ]);
    await createCaller(adminCtx(db)).event.setCheckInEnabled({
      id: "event-1",
      enabled: true,
    });

    expect(sets).toEqual([{ checkInEnabled: true }]);
  });

  it("is NOT_FOUND when the update matched no row", async () => {
    const { db } = updateReturningDb([]);
    const error = await rejection(
      createCaller(adminCtx(db)).event.setCheckInEnabled({
        id: "missing",
        enabled: false,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("refuses a MEMBER session before writing anything", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).event.setCheckInEnabled({
        id: "event-1",
        enabled: false,
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

function removeCheckInDb({
  locked,
  deleted,
}: {
  locked: { id: string; currentCheckIns: number } | undefined;
  deleted: { id: string }[];
}) {
  const sets: Record<string, unknown>[] = [];
  const order: string[] = [];

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    for: () => {
      order.push("lock");
      return Promise.resolve(locked ? [locked] : []);
    },
  };

  type StubDb = {
    transaction: (fn: (tx: StubDb) => Promise<unknown>) => Promise<unknown>;
    select: () => typeof selectChain;
    delete: () => {
      where: () => { returning: () => Promise<{ id: string }[]> };
    };
    update: () => {
      set: (values: Record<string, unknown>) => {
        where: () => Promise<undefined>;
      };
    };
  };

  const db: StubDb = {
    transaction: (fn) => fn(db),
    select: () => selectChain,
    delete: () => ({
      where: () => ({
        returning: () => {
          order.push("delete");
          return Promise.resolve(deleted);
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          sets.push(values);
          order.push("update");
          return Promise.resolve(undefined);
        },
      }),
    }),
  };

  return { db, sets, order };
}

describe("event.removeCheckIn", () => {
  it("removes the row and gives the seat back", async () => {
    const { db, sets, order } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 4 },
      deleted: [{ id: "check-in-1" }],
    });

    const result = await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "member-1",
    });

    expect(result).toEqual({ success: true });
    expect(sets).toEqual([{ currentCheckIns: 3 }]);
    expect(order).toEqual(["lock", "delete", "update"]);
  });

  it("leaves the counter alone when there was nothing to remove", async () => {
    const { db, sets, order } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 4 },
      deleted: [],
    });

    await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "never-came",
    });

    expect(sets).toEqual([]);
    expect(order).toEqual(["lock", "delete"]);
  });

  it("floors the counter at zero rather than going negative", async () => {
    const { db, sets } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 0 },
      deleted: [{ id: "check-in-1" }],
    });

    await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "member-1",
    });

    expect(sets).toEqual([{ currentCheckIns: 0 }]);
  });

  it("is NOT_FOUND for an event id that does not exist", async () => {
    const { db, order } = removeCheckInDb({ locked: undefined, deleted: [] });
    const error = await rejection(
      createCaller(adminCtx(db)).event.removeCheckIn({
        eventId: "missing",
        userId: "member-1",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(order).toEqual(["lock"]);
  });

  it("refuses a MEMBER session before opening a transaction", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).event.removeCheckIn({
        eventId: "event-1",
        userId: "member-1",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

function revokeSessionsDb(deleted: { sessionToken: string }[]) {
  const db = {
    delete: () => ({
      where: () => ({ returning: () => Promise.resolve(deleted) }),
    }),
  };
  return { db };
}

describe("member.revokeSessions", () => {
  it("reports how many sessions it actually dropped", async () => {
    const { db } = revokeSessionsDb([
      { sessionToken: "a" },
      { sessionToken: "b" },
    ]);

    const result = await createCaller(adminCtx(db)).member.revokeSessions({
      userId: "member-1",
    });

    expect(result).toEqual({ success: true, revoked: 2 });
  });

  it("succeeds with a zero count when there was nothing to revoke", async () => {
    const { db } = revokeSessionsDb([]);
    const result = await createCaller(adminCtx(db)).member.revokeSessions({
      userId: "member-1",
    });

    expect(result).toEqual({ success: true, revoked: 0 });
  });

  it("refuses a MEMBER session before deleting anything", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).member.revokeSessions({
        userId: "officer-1",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

describe("token bucket", () => {
  const OPTIONS = { limit: 3, intervalMs: 60_000 };
  const T0 = new Date("2026-09-01T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetRateLimits();
  });

  afterEach(() => vi.useRealTimers());

  it("spends the bucket and then refuses", () => {
    expect(takeToken("k", OPTIONS)).toBe(true);
    expect(takeToken("k", OPTIONS)).toBe(true);
    expect(takeToken("k", OPTIONS)).toBe(true);
    expect(takeToken("k", OPTIONS)).toBe(false);
  });

  it("restores one token per interval, not the whole bucket", () => {
    for (let call = 0; call < OPTIONS.limit; call++) takeToken("k", OPTIONS);
    expect(takeToken("k", OPTIONS)).toBe(false);

    vi.setSystemTime(T0 + 59_999);
    expect(takeToken("k", OPTIONS)).toBe(false);

    vi.setSystemTime(T0 + 60_000);
    expect(takeToken("k", OPTIONS)).toBe(true);
    expect(takeToken("k", OPTIONS)).toBe(false);
  });

  it("keeps callers in separate buckets", () => {
    for (let call = 0; call < OPTIONS.limit; call++) takeToken("a", OPTIONS);
    expect(takeToken("a", OPTIONS)).toBe(false);
    expect(takeToken("b", OPTIONS)).toBe(true);
  });

  it("evicts a bucket that has refilled, so the map stays bounded", () => {
    takeToken("a", OPTIONS);
    expect(rateLimitBucketCount()).toBe(1);

    vi.setSystemTime(T0 + 61_000);
    takeToken("b", OPTIONS);

    expect(rateLimitBucketCount()).toBe(1);
    expect(takeToken("a", OPTIONS)).toBe(true);
  });

  it("never evicts a bucket that is still over its limit", () => {
    const slow = { limit: 3, intervalMs: 600_000 };
    for (let call = 0; call < slow.limit; call++) takeToken("heavy", slow);
    expect(takeToken("heavy", slow)).toBe(false);

    vi.setSystemTime(T0 + 61_000);
    takeToken("other", slow);

    expect(takeToken("heavy", slow)).toBe(false);
  });
});
