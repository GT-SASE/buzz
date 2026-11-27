import { afterAll, beforeEach, describe, expect, it, mock, vi } from "bun:test";
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
const { EXPORT_ATTENDANCE_LIMIT } =
  await import("../../packages/api/src/rate-limit");
unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

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

function superAdminCtx(db: unknown): Ctx {
  return {
    db: withMemoryAudit(withMemoryLimiter(db)),
    session: {
      user: {
        id: "super-1",
        role: "SUPER_ADMIN",
        email: "super@gatech.edu",
      },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

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

beforeEach(() => {
  resetRateLimits();
  resetWrites();
});

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
  event: { id: string; title?: string } | undefined,
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

  it("logs the export with the event, the row count and whether it was cut off", async () => {
    const { db } = attendanceDb([attendanceRow(1), attendanceRow(2)], {
      id: "event-1",
      title: "GBM 3",
    });
    await createCaller(adminCtx(db)).event.exportAttendance({ id: "event-1" });

    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "export.attendance",
        targetType: "event",
        targetId: "event-1",
        targetLabel: "GBM 3",
        before: null,
        after: { rows: 2, truncated: false },
      },
    ]);
  });

  it("logs nothing when the event does not exist", async () => {
    const { db } = attendanceDb([], undefined);
    await rejection(
      createCaller(adminCtx(db)).event.exportAttendance({ id: "missing" }),
    );

    expect(auditRows).toEqual([]);
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
      query: {
        events: { findFirst: () => Promise.resolve({ startsAt: new Date() }) },
      },
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
  locked:
    | {
        id: string;
        title?: string;
        currentCheckIns: number;
        maxCheckIns: number | null;
      }
    | undefined;
  deleted: { id: string; pointsEarned?: number; method?: string }[];
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
    // The member's email, read once something was actually removed.
    then: (
      onFulfilled?: (value: { email: string }[]) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve([{ email: "member@gatech.edu" }]).then(
        onFulfilled,
        onRejected,
      ),
  };

  type StubDb = {
    transaction: (fn: (tx: StubDb) => Promise<unknown>) => Promise<unknown>;
    select: () => typeof selectChain;
    delete: () => {
      where: () => { returning: () => Promise<unknown[]> };
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
      locked: { id: "event-1", currentCheckIns: 4, maxCheckIns: 10 },
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

  it("takes the points back in the ledger and logs who removed what", async () => {
    const { db } = removeCheckInDb({
      locked: {
        id: "event-1",
        title: "GBM 3",
        currentCheckIns: 4,
        maxCheckIns: 10,
      },
      deleted: [{ id: "check-in-1", pointsEarned: 10, method: "code" }],
    });

    await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "member-1",
    });

    expect(ledgerRows).toEqual([
      {
        userId: "member-1",
        delta: -10,
        reason: "Check-in removed: GBM 3",
        source: "check_in_removed",
        eventId: "event-1",
        actedByUserId: "officer-1",
      },
    ]);
    expect(auditRows).toEqual([
      {
        actorId: "officer-1",
        action: "event.remove_check_in",
        targetType: "member",
        targetId: "member-1",
        targetLabel: "member@gatech.edu",
        before: {
          eventId: "event-1",
          event: "GBM 3",
          method: "code",
          points: 10,
        },
        after: null,
      },
    ]);
  });

  it("leaves the counter alone on an uncapped event", async () => {
    const { db, sets, order } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 0, maxCheckIns: null },
      deleted: [{ id: "check-in-1" }],
    });

    const result = await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "member-1",
    });

    expect(result).toEqual({ success: true });
    expect(sets).toEqual([]);
    expect(order).toEqual(["lock", "delete"]);
  });

  it("leaves the counter alone when there was nothing to remove", async () => {
    const { db, sets, order } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 4, maxCheckIns: 10 },
      deleted: [],
    });

    await createCaller(adminCtx(db)).event.removeCheckIn({
      eventId: "event-1",
      userId: "never-came",
    });

    expect(sets).toEqual([]);
    expect(order).toEqual(["lock", "delete"]);
    expect(auditRows).toEqual([]);
    expect(ledgerRows).toEqual([]);
  });

  it("floors the counter at zero rather than going negative", async () => {
    const { db, sets } = removeCheckInDb({
      locked: { id: "event-1", currentCheckIns: 0, maxCheckIns: 10 },
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

function revokeSessionsDb(
  deleted: { sessionToken: string }[],
  target: { role: "MEMBER" | "ADMIN" | "SUPER_ADMIN" } | null = {
    role: "MEMBER",
  },
) {
  const db = {
    query: {
      users: {
        findFirst: () => Promise.resolve(target),
      },
    },
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

  it("lets a super admin revoke sessions", async () => {
    const { db } = revokeSessionsDb([{ sessionToken: "a" }]);
    const result = await createCaller(superAdminCtx(db)).member.revokeSessions({
      userId: "member-1",
    });

    expect(result).toEqual({ success: true, revoked: 1 });
  });

  it("refuses an officer who tries to edit a super admin", async () => {
    let deleted = false;
    const db = {
      query: {
        users: {
          findFirst: () => Promise.resolve({ role: "SUPER_ADMIN" }),
        },
      },
      delete: () => {
        deleted = true;
        throw new Error("delete should not run");
      },
    };

    const error = await rejection(
      createCaller(adminCtx(db)).member.revokeSessions({
        userId: "super-1",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(deleted).toBe(false);
  });

  it("lets a super admin revoke another super admin", async () => {
    const { db } = revokeSessionsDb([{ sessionToken: "a" }], {
      role: "SUPER_ADMIN",
    });
    const result = await createCaller(superAdminCtx(db)).member.revokeSessions({
      userId: "super-2",
    });

    expect(result).toEqual({ success: true, revoked: 1 });
  });
});

type Role = "MEMBER" | "ADMIN" | "SUPER_ADMIN";

function setRoleDb(
  returned: { id: string; role: Role }[],
  before: { role: Role; email: string } | undefined = {
    role: "MEMBER",
    email: "member@gatech.edu",
  },
) {
  const sets: unknown[] = [];
  const db = {
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        for: () => Promise.resolve(before ? [before] : []),
      };
      return chain;
    },
    update: () => ({
      set: (value: unknown) => {
        sets.push(value);
        return {
          where: () => ({ returning: () => Promise.resolve(returned) }),
        };
      },
    }),
  };
  return { db, sets };
}

describe("member.setRole", () => {
  it("promotes a member to ADMIN", async () => {
    const { db, sets } = setRoleDb([{ id: "member-1", role: "ADMIN" }]);
    const result = await createCaller(superAdminCtx(db)).member.setRole({
      userId: "member-1",
      role: "ADMIN",
    });

    expect(sets).toEqual([{ role: "ADMIN" }]);
    expect(result).toEqual({ success: true, role: "ADMIN" });
  });

  it("logs the change with the role it replaced", async () => {
    const { db } = setRoleDb([{ id: "member-1", role: "ADMIN" }], {
      role: "MEMBER",
      email: "member@gatech.edu",
    });
    await createCaller(superAdminCtx(db)).member.setRole({
      userId: "member-1",
      role: "ADMIN",
    });

    expect(auditRows).toEqual([
      {
        actorId: "super-1",
        action: "member.set_role",
        targetType: "member",
        targetId: "member-1",
        targetLabel: "member@gatech.edu",
        before: { role: "MEMBER" },
        after: { role: "ADMIN" },
      },
    ]);
  });

  it("logs nothing when the role does not change", async () => {
    const { db } = setRoleDb([{ id: "member-1", role: "ADMIN" }], {
      role: "ADMIN",
      email: "member@gatech.edu",
    });
    await createCaller(superAdminCtx(db)).member.setRole({
      userId: "member-1",
      role: "ADMIN",
    });

    expect(auditRows).toEqual([]);
  });

  it("demotes an officer to MEMBER", async () => {
    const { db, sets } = setRoleDb([{ id: "officer-2", role: "MEMBER" }]);
    const result = await createCaller(superAdminCtx(db)).member.setRole({
      userId: "officer-2",
      role: "MEMBER",
    });

    expect(sets).toEqual([{ role: "MEMBER" }]);
    expect(result).toEqual({ success: true, role: "MEMBER" });
  });

  it("can assign SUPER_ADMIN", async () => {
    const { db, sets } = setRoleDb([{ id: "officer-2", role: "SUPER_ADMIN" }]);
    const result = await createCaller(superAdminCtx(db)).member.setRole({
      userId: "officer-2",
      role: "SUPER_ADMIN",
    });

    expect(sets).toEqual([{ role: "SUPER_ADMIN" }]);
    expect(result).toEqual({ success: true, role: "SUPER_ADMIN" });
  });

  it("refuses a super admin demoting themself before writing", async () => {
    const error = await rejection(
      createCaller(superAdminCtx(unreachableDb)).member.setRole({
        userId: "super-1",
        role: "ADMIN",
      }),
    );

    expect(error.code).toBe("BAD_REQUEST");
  });

  it("404s when the user row is missing", async () => {
    const { db } = setRoleDb([], undefined);
    const error = await rejection(
      createCaller(superAdminCtx(db)).member.setRole({
        userId: "missing",
        role: "ADMIN",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(auditRows).toEqual([]);
  });

  it("refuses an ADMIN before writing", async () => {
    const error = await rejection(
      createCaller(adminCtx(unreachableDb)).member.setRole({
        userId: "member-2",
        role: "MEMBER",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a MEMBER before writing", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).member.setRole({
        userId: "member-2",
        role: "ADMIN",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});
