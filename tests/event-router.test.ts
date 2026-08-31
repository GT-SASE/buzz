import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Unit coverage for the helpers inside packages/api/src/routers/event.ts. None
 * of them are exported, so each is driven through the narrowest public surface
 * that reaches it: the router's own `createCaller`, with a stub `db`. Nothing
 * in this file opens a connection.
 *
 * The import is dynamic, under a production NODE_ENV, on purpose. tRPC
 * config is frozen at `initTRPC.create()` — i.e. the moment
 * `@buzz/api/trpc` is first evaluated — so tests pin production the same
 * way deploy does.
 */
/**
 * `@buzz/auth` is reachable from the router only through `createTRPCContext`,
 * which these tests never call — but importing it evaluates next-auth, which
 * reaches for `next/server` and does not resolve outside the Next bundler.
 * Stubbed so the router can be imported at all; nothing here authenticates.
 */
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

/**
 * Returns the rejection, or fails loudly if the call resolved instead.
 * Typed structurally so this file needs no dependency of its own — neither
 * @trpc/server nor drizzle-orm is resolvable from the repo root.
 */
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

// The timing middleware logs one line per call, and one test makes thousands.
const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
afterAll(() => consoleLog.mockRestore());

// ---------------------------------------------------------------- stub tables

/** `db.insert(events).values(...).returning()` — records what was written. */
function insertCapturingDb() {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return {
          returning: () => Promise.resolve([{ id: "event-1", ...values }]),
        };
      },
    }),
  };
  return { db, inserted };
}

/**
 * `db.transaction` + lock + count + update. The recount is a SELECT under
 * `FOR UPDATE`, not a SQL subquery inside SET — same race safety, Drizzle ORM.
 */
function updateCapturingDb() {
  const sets: Record<string, unknown>[] = [];
  const selectChain = () => {
    const chain = {
      from: () => chain,
      where: () => chain,
      for: () => Promise.resolve([{ id: "event-1" }]),
      then: (
        onFulfilled?: (value: { total: number }[]) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve([{ total: 7 }]).then(onFulfilled, onRejected),
    };
    return chain;
  };
  type StubDb = {
    transaction: (fn: (tx: StubDb) => Promise<unknown>) => Promise<unknown>;
    select: typeof selectChain;
    update: () => {
      set: (values: Record<string, unknown>) => {
        where: () => {
          returning: () => Promise<Record<string, unknown>[]>;
        };
      };
    };
  };
  const db: StubDb = {
    transaction: (fn) => fn(db),
    select: selectChain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        sets.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ id: "event-1", ...values }]),
          }),
        };
      },
    }),
  };
  return { db, sets };
}

/** Any touch is a failure: proves input validation runs before any write. */
const unreachableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `db.${String(property)} was reached; input should have been rejected first`,
      );
    },
  },
);

const startsAt = new Date("2026-09-01T18:00:00.000Z");
const validEvent = {
  title: "Fall Kickoff",
  startsAt,
  pointsValue: 5,
};

// ------------------------------------------------------------ isUniqueViolation

/**
 * `manualCheckIn` is the narrowest surface that reaches the helper: whatever the
 * transaction throws is handed straight to it, and the answer is observable as
 * CONFLICT (matched) versus the raw error being rethrown and surfacing as
 * INTERNAL_SERVER_ERROR (not matched).
 */
function throwingTransactionDb(thrown: unknown) {
  return {
    query: {
      users: {
        findFirst: () =>
          Promise.resolve({
            id: "member-1",
            name: "Ada Lovelace",
            email: "member@gatech.edu",
          }),
      },
      events: {
        findFirst: () => Promise.resolve({ id: "event-1", pointsValue: 5 }),
      },
    },
    // Rejecting with a non-Error is the entire point: `isUniqueViolation` has
    // to walk whatever the driver threw, and postgres.js errors reach it as
    // plain objects carrying a SQLSTATE rather than as Error instances. A test
    // that only ever threw Errors would not exercise the branch that matters.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    transaction: () => Promise.reject(thrown),
  };
}

function manualCheckInWith(thrown: unknown) {
  return rejection(
    createCaller(adminCtx(throwingTransactionDb(thrown))).event.manualCheckIn({
      eventId: "event-1",
      email: "member@gatech.edu",
    }),
  );
}

describe("isUniqueViolation (through event.manualCheckIn)", () => {
  beforeAll(() => {
    resetRateLimits();
  });

  it("matches a bare driver object carrying 23505", async () => {
    const error = await manualCheckInWith({ code: "23505" });
    expect(error.code).toBe("CONFLICT");
  });

  /**
   * The regression this helper exists for. Drizzle wraps every driver error, so
   * the pg error carrying the SQLSTATE sits on `.cause`, not on the object that
   * was thrown. A top-level-only check compiles, passes every unit test written
   * against a bare object, and then never matches once — every genuine double
   * check-in surfaces as an unexplained 500 instead of "already checked in".
   */
  it("matches 23505 two levels down the cause chain", async () => {
    const driverError = { code: "23505", constraint: "event_check_ins_pkey" };
    const wrapped = new Error("Failed query", { cause: driverError });
    const error = await manualCheckInWith(wrapped);
    expect(error.code).toBe("CONFLICT");
  });

  it("matches 23505 three levels down the cause chain", async () => {
    const driverError = { code: "23505" };
    const inner = new Error("driver", { cause: driverError });
    const outer = new Error("Failed query", { cause: inner });
    const error = await manualCheckInWith(outer);
    expect(error.code).toBe("CONFLICT");
  });

  it("leaves a different SQLSTATE alone", async () => {
    // 23503 is foreign_key_violation — a real bug, and reporting it as
    // "already checked in" would hide it from whoever has to fix it.
    const error = await manualCheckInWith(
      new Error("Failed query", { cause: { code: "23503" } }),
    );
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("leaves a plain Error alone", async () => {
    const error = await manualCheckInWith(new Error("connection terminated"));
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("does not match a string sitting in the cause chain", async () => {
    const error = await manualCheckInWith(
      new Error("Failed query", { cause: "23505" }),
    );
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
  });

  it("survives a null or undefined error", async () => {
    expect((await manualCheckInWith(null)).code).toBe("INTERNAL_SERVER_ERROR");
    expect((await manualCheckInWith(undefined)).code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
    expect((await manualCheckInWith({ cause: null })).code).toBe(
      "INTERNAL_SERVER_ERROR",
    );
  });

  /**
   * A cause chain can be circular — an error re-thrown with itself as its own
   * cause is enough. Walking it without a bound hangs the request thread rather
   * than failing, which is the worst possible failure mode for the door. If the
   * walk ever stops terminating, this test times out instead of passing.
   */
  it("terminates on a self-referencing cause chain", async () => {
    const looping: { message: string; cause?: unknown } = { message: "loop" };
    looping.cause = looping;
    expect((await manualCheckInWith(looping)).code).toBe(
      "INTERNAL_SERVER_ERROR",
    );

    const loopingMatch: { code: string; cause?: unknown } = { code: "23505" };
    loopingMatch.cause = loopingMatch;
    expect((await manualCheckInWith(loopingMatch)).code).toBe("CONFLICT");
  });
});

// ------------------------------------------------------------- check-in codes

describe("check-in code generation (through event.regenerateCode)", () => {
  const CODE_LENGTH = 8;
  const EXPECTED_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  const SAMPLES = 3000;
  const codes: string[] = [];

  beforeAll(async () => {
    for (let index = 0; index < SAMPLES; index++) {
      resetRateLimits();
      const { db, sets } = updateCapturingDb();
      await createCaller(adminCtx(db)).event.regenerateCode({ id: "event-1" });
      codes.push(sets[0]!.checkInCode as string);
    }
  });

  it("emits a fixed-length code every time", () => {
    expect(codes).toHaveLength(SAMPLES);
    for (const code of codes) {
      expect(code).toHaveLength(CODE_LENGTH);
    }
  });

  /**
   * The entire reason this alphabet is not plain base32: members read the code
   * off a projector across a lecture hall and retype it on a phone. I/1/L, O/0
   * and U/V are the pairs that get mistyped, and every one of them is a member
   * standing at the door telling an officer the code does not work.
   */
  it("never emits an ambiguous glyph", () => {
    const ambiguous = /[ILOU01]/;
    const offenders = codes.filter((code) => ambiguous.test(code));
    expect(offenders).toEqual([]);
  });

  it("emits nothing outside the expected alphabet", () => {
    const allowed = new Set(EXPECTED_ALPHABET);
    const seen = new Set(codes.join(""));
    expect([...seen].filter((glyph) => !allowed.has(glyph))).toEqual([]);
  });

  /**
   * The mirror of the test above: pins the alphabet from both sides so that
   * quietly dropping glyphs (and shrinking the keyspace) fails here. 24000
   * sampled characters over 30 glyphs — a missing glyph is not a coin flip.
   */
  it("uses the whole 30-glyph alphabet", () => {
    const seen = new Set(codes.join(""));
    expect([...seen].sort().join("")).toBe(
      [...EXPECTED_ALPHABET].sort().join(""),
    );
  });

  /** Rotation is a revocation mechanism, so it has to actually rotate. */
  it("produces a different code on each call", () => {
    expect(new Set(codes).size).toBe(SAMPLES);
  });
});

// ------------------------------------------------------------ input validation

describe("eventInput (through event.create)", () => {
  const caller = () => createCaller(adminCtx(unreachableDb)).event;

  it("rejects a points value outside 0..100", async () => {
    expect(
      (await rejection(caller().create({ ...validEvent, pointsValue: -1 })))
        .code,
    ).toBe("BAD_REQUEST");
    expect(
      (await rejection(caller().create({ ...validEvent, pointsValue: 101 })))
        .code,
    ).toBe("BAD_REQUEST");
  });

  it("rejects a fractional points value", async () => {
    // Points are summed into a member's total; a fraction there is a rounding
    // argument nobody wants to have.
    const error = await rejection(
      caller().create({ ...validEvent, pointsValue: 2.5 }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("accepts both ends of the points range", async () => {
    for (const pointsValue of [0, 100]) {
      const { db, inserted } = insertCapturingDb();
      await createCaller(adminCtx(db)).event.create({
        ...validEvent,
        pointsValue,
      });
      expect(inserted[0]!.pointsValue).toBe(pointsValue);
    }
  });

  it("rejects a blank title", async () => {
    expect(
      (await rejection(caller().create({ ...validEvent, title: "" }))).code,
    ).toBe("BAD_REQUEST");
  });

  /**
   * `.trim()` runs before `.min(1)`, so a title of nothing but spaces is a
   * blank title. Without that ordering an event ships with an invisible name
   * and cannot be told apart from any other in the officer list.
   */
  it("rejects a whitespace-only title", async () => {
    const error = await rejection(
      caller().create({ ...validEvent, title: "   \t \n " }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("rejects a title over 200 characters and accepts exactly 200", async () => {
    expect(
      (
        await rejection(
          caller().create({ ...validEvent, title: "a".repeat(201) }),
        )
      ).code,
    ).toBe("BAD_REQUEST");

    const { db, inserted } = insertCapturingDb();
    await createCaller(adminCtx(db)).event.create({
      ...validEvent,
      title: "a".repeat(200),
    });
    expect(inserted[0]!.title).toBe("a".repeat(200));
  });

  it("stores the title trimmed", async () => {
    const { db, inserted } = insertCapturingDb();
    await createCaller(adminCtx(db)).event.create({
      ...validEvent,
      title: "  Fall Kickoff  ",
    });
    expect(inserted[0]!.title).toBe("Fall Kickoff");
  });

  it("rejects a negative or zero capacity", async () => {
    expect(
      (await rejection(caller().create({ ...validEvent, maxCheckIns: -1 })))
        .code,
    ).toBe("BAD_REQUEST");
    // Zero is not "uncapped", it is an event nobody can enter; null is uncapped.
    expect(
      (await rejection(caller().create({ ...validEvent, maxCheckIns: 0 })))
        .code,
    ).toBe("BAD_REQUEST");
  });

  it("treats an omitted capacity as uncapped null, never undefined", async () => {
    const { db, inserted } = insertCapturingDb();
    await createCaller(adminCtx(db)).event.create(validEvent);
    expect(inserted[0]).toHaveProperty("maxCheckIns", null);
  });

  /**
   * `z.coerce.date()` runs `new Date(input)`, which answers Invalid Date rather
   * than throwing. Letting one through stores an unformattable timestamp that
   * only fails later, inside a formatter, as "RangeError: Invalid time value" —
   * on a page that has nothing to do with whoever typed it.
   */
  it("rejects an unparseable startsAt rather than storing Invalid Date", async () => {
    const error = await rejection(
      caller().create({
        ...validEvent,
        startsAt: "next tuesday",
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  /**
   * The check-in code is a bearer credential. If the input schema ever stopped
   * stripping unknown keys, any officer could pin an event's code to a value of
   * their choosing — and `createdById` is audit data, so it has to come from
   * the session rather than the request body.
   */
  it("never lets the request body choose checkInCode or createdById", async () => {
    const { db, inserted } = insertCapturingDb();
    await createCaller(adminCtx(db)).event.create({
      ...validEvent,
      checkInCode: "AAAAAAAA",
      createdById: "somebody-else",
      currentCheckIns: 999,
    } as unknown as typeof validEvent);

    expect(inserted[0]!.checkInCode).not.toBe("AAAAAAAA");
    expect(inserted[0]!.createdById).toBe("officer-1");
    expect(inserted[0]).not.toHaveProperty("currentCheckIns");
  });
});

// --------------------------------------------------------- clearing a column

describe("event.update", () => {
  /**
   * The regression. Drizzle strips `undefined` out of an update set entirely,
   * so an omitted optional field means the column is simply absent from the
   * UPDATE: clearing an event's location or description silently did nothing,
   * the mutation reported success, and the old text kept rendering to members.
   * Every nullable column has to reach `.set()` as an explicit null.
   */
  it("writes an explicit null for every omitted nullable column", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.update({
      id: "event-1",
      ...validEvent,
    });

    expect(sets).toHaveLength(1);
    const written = sets[0]!;
    expect(written).toHaveProperty("description", null);
    expect(written).toHaveProperty("location", null);
    expect(written).toHaveProperty("maxCheckIns", null);
    // toHaveProperty passes on an inherited or undefined value; these are the
    // assertions that fail if the key is present but undefined.
    expect(Object.keys(written)).toEqual(
      expect.arrayContaining(["description", "location", "maxCheckIns"]),
    );
    for (const key of ["description", "location", "maxCheckIns"]) {
      expect(written[key]).not.toBeUndefined();
    }
  });

  it("passes supplied values through untouched", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.update({
      id: "event-1",
      ...validEvent,
      description: "Boba and resumes",
      location: "Klaus 1443",
      maxCheckIns: 60,
    });

    expect(sets[0]).toMatchObject({
      description: "Boba and resumes",
      location: "Klaus 1443",
      maxCheckIns: 60,
    });
  });

  it("never writes the id into the SET payload", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.update({
      id: "event-1",
      ...validEvent,
    });
    expect(sets[0]).not.toHaveProperty("id");
  });

  /**
   * The uncapped check-in path leaves `currentCheckIns` untouched, so the
   * moment a capacity is added the counter may be stale and the gate it feeds
   * would admit past the limit. Adding a capacity has to recount.
   */
  it("recounts currentCheckIns when a capacity is set", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.update({
      id: "event-1",
      ...validEvent,
      maxCheckIns: 60,
    });

    expect(sets[0]).toHaveProperty("currentCheckIns");
    // Recounted under the event row lock, then written as a plain integer.
    expect(sets[0]!.currentCheckIns).toBe(7);
  });

  it("leaves currentCheckIns alone when the event stays uncapped", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.update({
      id: "event-1",
      ...validEvent,
    });
    expect(sets[0]).not.toHaveProperty("currentCheckIns");
  });
});

describe("event.setArchived", () => {
  /** Same `undefined` trap: un-archiving has to send a null, not an absence. */
  it("clears archivedAt with an explicit null when un-archiving", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.setArchived({
      id: "event-1",
      archived: false,
    });
    expect(sets[0]).toHaveProperty("archivedAt", null);
  });

  it("stamps a date when archiving", async () => {
    const { db, sets } = updateCapturingDb();
    await createCaller(adminCtx(db)).event.setArchived({
      id: "event-1",
      archived: true,
    });
    expect(sets[0]!.archivedAt).toBeInstanceOf(Date);
  });
});

// ------------------------------------------------------------- normalizeCode

describe("normalizeCode (through event.checkIn)", () => {
  /**
   * A scanner hands back whatever the QR encoded, including stray whitespace,
   * and a code pulled out of a URL keeps its original case. The lookup is an
   * exact match on a stored uppercase code, so everything has to be folded
   * before the query — not after, and not never.
   */
  it("uppercases and strips separators before the lookup", async () => {
    let lookup: unknown;
    const events = {
      findFirst: (config: { where: unknown }) => {
        lookup = config.where;
        return Promise.resolve(undefined);
      },
    };
    // The event lookup now runs OUTSIDE any transaction: nothing about it is
    // mutated, and holding a transaction open across it was contention every
    // concurrent scanner paid for. The stub exposes it both ways so this test
    // pins the folding behaviour rather than the call site.
    const db = {
      query: { events },
      transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ query: { events } }),
    };

    const error = await rejection(
      createCaller(memberCtx(db)).event.checkIn({ code: " sase-gt 26 " }),
    );
    expect(error.code).toBe("NOT_FOUND");

    // The `where` is a drizzle SQL fragment; its bound parameters are the
    // chunks carrying a `value`. If that shape ever changes this finds nothing
    // and the assertion fails rather than passing vacuously.
    const chunks =
      (lookup as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
    const bound = chunks
      .filter(
        (chunk): chunk is { value: unknown } =>
          typeof chunk === "object" && chunk !== null && "value" in chunk,
      )
      .map((chunk) => chunk.value);
    expect(bound).toContain("SASEGT26");
  });
});
