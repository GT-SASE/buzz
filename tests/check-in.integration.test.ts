import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * `@buzz/auth` is stubbed before anything imports the router.
 *
 * Nothing here calls `auth()` — every context below carries a session object
 * built by hand — but `packages/api/src/trpc.ts` imports the module at load
 * time, which drags next-auth and `next/server` into a plain node environment
 * where they do not resolve. The stub keeps the import graph honest without
 * changing a line of what is under test: the procedures, their guards, and the
 * SQL they run are all the real ones.
 */
vi.mock("../packages/auth/src/index.ts", () => ({
  auth: async () => null,
  handlers: {},
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

/**
 * Imported by path rather than by the `@buzz/*` specifier the app uses.
 *
 * Vitest resolves a bare specifier from the importing file's directory, and
 * this file sits at the repo root, where pnpm has installed no workspace links
 * and no drizzle-orm — both live in the per-package node_modules under
 * `sites/web` and `packages`. Symlinks resolve to their real path, so these are
 * the same module instances the router itself loads: the `db` below is the very
 * connection the procedures write through, and the operators below build
 * conditions over the same Column objects.
 */
const { db, eventCheckIns, events, users } =
  await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { and, eq, inArray } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

/** The dev-mode timing middleware sleeps up to 400ms per call. */
const SLOW = 30_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The generator's alphabet: no I, L, O, U, 0 or 1. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Never a fixed string. The seeded demo codes (SASEGT26, WKSHP789, TASTE234)
 * belong to rows this suite must leave alone, and `checkInCode` is uniquely
 * indexed, so a hardcoded code here would collide with a second developer
 * running the suite against the same shared database.
 */
function randomCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % 30]).join("");
}

type TestUser = { id: string; email: string; role: "MEMBER" | "ADMIN" };

/**
 * The context `createTRPCContext` would have built, minus next-auth: the same
 * `db`, a session shaped the way the Auth.js callback shapes it, and headers
 * nothing under test reads. The role on the session is what `adminProcedure`
 * reads, so a caller made here is exactly as privileged as the row it was made
 * from — passing `null` produces a signed-out caller.
 */
function makeCaller(session: unknown) {
  return createCaller({ db, session, headers: new Headers() } as Parameters<
    typeof createCaller
  >[0]);
}

function callerFor(user: TestUser) {
  return makeCaller({
    user: { id: user.id, role: user.role, email: user.email, name: "vitest" },
    expires: new Date(Date.now() + DAY_MS).toISOString(),
  });
}

/**
 * The tRPC error code, or "NO_ERROR" when the call wrongly succeeded — which
 * reads in the failure output as the thing that actually went wrong, rather
 * than as an unhandled rejection somewhere else.
 */
async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

function countCheckIns(eventId: string) {
  return db.query.eventCheckIns
    .findMany({ where: eq(eventCheckIns.eventId, eventId) })
    .then((rows) => rows.length);
}

function readEvent(id: string) {
  return db.query.events.findFirst({ where: eq(events.id, id) });
}

// --------------------------------------------------------------------------

describe.skipIf(!process.env.DATABASE_URL)("check-in", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const eventIds: string[] = [];

  let admin: TestUser;
  let statsMember: TestUser;
  let gateMember: TestUser;
  let extraMember: TestUser;

  const code = {
    snapshot: randomCode(),
    duplicate: randomCode(),
    stale: randomCode(),
    fresh: randomCode(),
    disabled: randomCode(),
    archived: randomCode(),
    capped: randomCode(),
    race: randomCode(),
    raceDuplicate: randomCode(),
    spaced: randomCode(),
    editable: randomCode(),
  };
  const allCodes = Object.values(code);

  const id = {} as Record<keyof typeof code, string>;

  async function makeUser(
    tag: string,
    role: "MEMBER" | "ADMIN",
  ): Promise<TestUser> {
    const [row] = await db
      .insert(users)
      .values({
        email: `vitest-${tag}-${suffix}@example.invalid`,
        name: `vitest ${tag}`,
        role,
      })
      .returning();
    if (!row) throw new Error(`could not create the ${tag} test user`);
    userIds.push(row.id);
    return { id: row.id, email: row.email, role };
  }

  beforeAll(async () => {
    admin = await makeUser("officer", "ADMIN");
    statsMember = await makeUser("member-a", "MEMBER");
    gateMember = await makeUser("member-b", "MEMBER");
    extraMember = await makeUser("member-c", "MEMBER");

    const now = Date.now();
    const rows = await db
      .insert(events)
      .values([
        {
          title: "vitest snapshot",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.snapshot,
          createdById: admin.id,
        },
        {
          title: "vitest duplicate",
          startsAt: new Date(now),
          pointsValue: 5,
          checkInCode: code.duplicate,
          createdById: admin.id,
        },
        {
          title: "vitest stale",
          // 25 hours ago: one hour past the door.
          startsAt: new Date(now - 25 * 60 * 60 * 1000),
          pointsValue: 10,
          checkInCode: code.stale,
          createdById: admin.id,
        },
        {
          title: "vitest fresh",
          // 23 hours ago: the far side of the same boundary.
          startsAt: new Date(now - 23 * 60 * 60 * 1000),
          pointsValue: 10,
          checkInCode: code.fresh,
          createdById: admin.id,
        },
        {
          title: "vitest disabled",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.disabled,
          checkInEnabled: false,
          createdById: admin.id,
        },
        {
          title: "vitest archived",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.archived,
          archivedAt: new Date(now),
          createdById: admin.id,
        },
        {
          title: "vitest capped",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.capped,
          maxCheckIns: 1,
          createdById: admin.id,
        },
        {
          title: "vitest race",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.race,
          maxCheckIns: 1,
          createdById: admin.id,
        },
        {
          title: "vitest race duplicate",
          startsAt: new Date(now),
          pointsValue: 7,
          checkInCode: code.raceDuplicate,
          createdById: admin.id,
        },
        {
          title: "vitest spaced",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.spaced,
          createdById: admin.id,
        },
        {
          title: "vitest editable",
          description: "Text that an officer is about to clear.",
          location: "Klaus 1443",
          startsAt: new Date(now),
          pointsValue: 10,
          checkInCode: code.editable,
          maxCheckIns: 25,
          createdById: admin.id,
        },
      ])
      .returning({ id: events.id, checkInCode: events.checkInCode });

    for (const row of rows) {
      eventIds.push(row.id);
      const key = (Object.keys(code) as (keyof typeof code)[]).find(
        (name) => code[name] === row.checkInCode,
      );
      if (key) id[key] = row.id;
    }
  }, SLOW);

  /**
   * Check-ins, then events, then users: the FKs point that way, and a run that
   * failed halfway still has to leave the shared database as it found it.
   */
  afterAll(async () => {
    if (eventIds.length > 0) {
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.eventId, eventIds));
      await db.delete(events).where(inArray(events.id, eventIds));
    }
    if (userIds.length > 0) {
      await db
        .delete(eventCheckIns)
        .where(inArray(eventCheckIns.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  }, SLOW);

  // ------------------------------------------------------------------------

  describe("the points snapshot", () => {
    /**
     * The property the whole feature rests on. `pointsEarned` is stamped onto
     * the attendance row at the door and never read back off the event, so
     * re-pricing an event cannot rewrite the history of anybody who already
     * turned up. Recomputing totals from `events.pointsValue` instead would
     * pass every other test in this file and silently rewrite the leaderboard
     * the first time an officer fixed a typo in a points value.
     */
    it(
      "stamps the event's value onto the row and into the member's total",
      async () => {
        const caller = callerFor(statsMember);
        const result = await caller.event.checkIn({ code: code.snapshot });

        expect(result.pointsEarned).toBe(10);
        expect(result.totalPoints).toBe(10);
        expect(result.totalEvents).toBe(1);

        // `sum()` and `count()` come back from postgres as strings without the
        // ::int casts in `totalsColumns`; arithmetic on the client would then
        // concatenate rather than add.
        expect(typeof result.totalPoints).toBe("number");
        expect(typeof result.totalEvents).toBe("number");
      },
      SLOW,
    );

    it(
      "leaves an existing row and total untouched when the event is re-priced",
      async () => {
        await callerFor(admin).event.update({
          id: id.snapshot,
          title: "vitest snapshot",
          startsAt: new Date(),
          pointsValue: 50,
        });

        const row = await db.query.eventCheckIns.findFirst({
          where: and(
            eq(eventCheckIns.eventId, id.snapshot),
            eq(eventCheckIns.userId, statsMember.id),
          ),
        });
        expect(row?.pointsEarned).toBe(10);

        const stats = await callerFor(statsMember).event.myStats();
        expect(stats.totalPoints).toBe(10);
        expect(stats.totalEvents).toBe(1);

        const mine = await callerFor(statsMember).event.myEvents();
        expect(mine.find((e) => e.id === id.snapshot)?.pointsEarned).toBe(10);
      },
      SLOW,
    );

    it(
      "prices a check-in taken after the change at the new value",
      async () => {
        const result = await callerFor(extraMember).event.checkIn({
          code: code.snapshot,
        });
        expect(result.pointsEarned).toBe(50);
      },
      SLOW,
    );

    /**
     * `memberSince` is an aggregate, not a column. Declared as a raw
     * `min(checked_in_at)` the driver hands it back unparsed, the `Date` the
     * type promised never materialises, and the first `Intl.DateTimeFormat` on
     * the dashboard throws "RangeError: Invalid time value". The type was the
     * lie; only a value assertion catches it.
     */
    it(
      "returns memberSince as a usable Date",
      async () => {
        const stats = await callerFor(statsMember).event.myStats();

        expect(stats.memberSince).toBeInstanceOf(Date);
        expect(Number.isNaN(stats.memberSince!.getTime())).toBe(false);
        // Stamped moments ago, so anything outside a day is a timezone or
        // parsing fault rather than a clock difference.
        expect(
          Math.abs(Date.now() - stats.memberSince!.getTime()),
        ).toBeLessThan(DAY_MS);
      },
      SLOW,
    );
  });

  describe("double check-in", () => {
    it(
      "refuses the second tap without writing a row or moving the counter",
      async () => {
        const caller = callerFor(gateMember);
        const first = await caller.event.checkIn({ code: code.duplicate });
        expect(first.pointsEarned).toBe(5);

        expect(
          await errorCode(caller.event.checkIn({ code: code.duplicate })),
        ).toBe("CONFLICT");

        expect(await countCheckIns(id.duplicate)).toBe(1);
        // This event is uncapped, so the counter is deliberately never touched:
        // it exists only to settle capacity, and maintaining it would make
        // every scanner serialise on one row. Attendance is the row count.
        expect((await readEvent(id.duplicate))?.currentCheckIns).toBe(0);

        const stats = await caller.event.myStats();
        expect(stats.totalPoints).toBe(5);
        expect(stats.totalEvents).toBe(1);
      },
      SLOW,
    );
  });

  describe("the 24 hour window", () => {
    /**
     * A code photographed off a projector otherwise keeps admitting people for
     * the rest of the semester, long after the list has stopped advertising the
     * event.
     */
    it(
      "refuses an event 25 hours past its start",
      async () => {
        expect(
          await errorCode(
            callerFor(gateMember).event.checkIn({ code: code.stale }),
          ),
        ).toBe("BAD_REQUEST");
        expect(await countCheckIns(id.stale)).toBe(0);
      },
      SLOW,
    );

    it(
      "still admits an event 23 hours past its start",
      async () => {
        const result = await callerFor(gateMember).event.checkIn({
          code: code.fresh,
        });
        expect(result.pointsEarned).toBe(10);
      },
      SLOW,
    );
  });

  describe("a closed door", () => {
    it(
      "refuses an event with check-in disabled",
      async () => {
        expect(
          await errorCode(
            callerFor(gateMember).event.checkIn({ code: code.disabled }),
          ),
        ).toBe("BAD_REQUEST");
        expect(await countCheckIns(id.disabled)).toBe(0);
      },
      SLOW,
    );

    it(
      "refuses an archived event",
      async () => {
        expect(
          await errorCode(
            callerFor(gateMember).event.checkIn({ code: code.archived }),
          ),
        ).toBe("BAD_REQUEST");
        expect(await countCheckIns(id.archived)).toBe(0);
      },
      SLOW,
    );
  });

  describe("capacity", () => {
    it(
      "admits up to maxCheckIns and refuses the next member",
      async () => {
        const admitted = await callerFor(gateMember).event.checkIn({
          code: code.capped,
        });
        expect(admitted.pointsEarned).toBe(10);

        expect(
          await errorCode(
            callerFor(extraMember).event.checkIn({ code: code.capped }),
          ),
        ).toBe("BAD_REQUEST");

        expect(await countCheckIns(id.capped)).toBe(1);
        expect((await readEvent(id.capped))?.currentCheckIns).toBe(1);
      },
      SLOW,
    );

    /**
     * Two phones at the door at once. Read-then-insert on separate connections
     * decides on identical snapshots and lets a one-seat event admit two, which
     * is why `checkIn` locks the event row before it reads the counter and
     * re-tests the cap inside the UPDATE that increments it. Sequential tests
     * pass either way; only overlapping transactions tell the two apart.
     */
    it(
      "admits exactly one of two simultaneous taps on a one-seat event",
      async () => {
        const results = await Promise.all([
          errorCode(callerFor(gateMember).event.checkIn({ code: code.race })),
          errorCode(callerFor(extraMember).event.checkIn({ code: code.race })),
        ]);

        expect(results.filter((r) => r === "NO_ERROR")).toHaveLength(1);
        expect(results.filter((r) => r === "BAD_REQUEST")).toHaveLength(1);
        expect(await countCheckIns(id.race)).toBe(1);
        expect((await readEvent(id.race))?.currentCheckIns).toBe(1);
      },
      SLOW,
    );

    /**
     * The same member, twice, at the same instant — a double tap on a slow
     * connection. The loser has to come back as the same CONFLICT a sequential
     * retry gets; surfacing the raw unique violation instead would show the
     * member an unexplained failure for something they already succeeded at.
     */
    it(
      "writes one row and one member's points for two simultaneous taps",
      async () => {
        const caller = callerFor(extraMember);
        const results = await Promise.all([
          errorCode(caller.event.checkIn({ code: code.raceDuplicate })),
          errorCode(caller.event.checkIn({ code: code.raceDuplicate })),
        ]);

        expect(results.filter((r) => r === "NO_ERROR")).toHaveLength(1);
        expect(results.filter((r) => r === "CONFLICT")).toHaveLength(1);
        expect(await countCheckIns(id.raceDuplicate)).toBe(1);
        // Uncapped: counter untouched by design, row count is the truth.
        expect((await readEvent(id.raceDuplicate))?.currentCheckIns).toBe(0);
      },
      SLOW,
    );
  });

  describe("the code itself", () => {
    /**
     * Members retype these off a projector on a phone keyboard that likes to
     * insert spaces and lowercase the first letter. Matching the column
     * verbatim turns every one of those into a support message.
     */
    it(
      "matches a lowercased code with interior spaces",
      async () => {
        const spaced = `  ${code.spaced.slice(0, 4)} ${code.spaced.slice(4)} `;
        const result = await callerFor(gateMember).event.checkIn({
          code: spaced.toLowerCase(),
        });
        expect(result.eventTitle).toBe("vitest spaced");
      },
      SLOW,
    );

    it(
      "returns NOT_FOUND for a code no event holds",
      async () => {
        expect(
          await errorCode(
            callerFor(gateMember).event.checkIn({ code: randomCode() }),
          ),
        ).toBe("NOT_FOUND");
      },
      SLOW,
    );
  });

  describe("adminProcedure", () => {
    /**
     * The route layout also redirects non-officers, but that is cosmetic — a
     * member holding a session cookie can call the procedure directly, so this
     * middleware is the only thing between them and the roster.
     */
    it(
      "refuses a MEMBER session with FORBIDDEN",
      async () => {
        const member = callerFor(gateMember);
        expect(await errorCode(member.event.listAll({}))).toBe("FORBIDDEN");
        expect(await errorCode(member.event.getById({ id: id.snapshot }))).toBe(
          "FORBIDDEN",
        );
        expect(
          await errorCode(member.event.regenerateCode({ id: id.snapshot })),
        ).toBe("FORBIDDEN");
      },
      SLOW,
    );

    it(
      "admits an ADMIN session",
      async () => {
        const listing = await callerFor(admin).event.listAll({});
        expect(Array.isArray(listing.events)).toBe(true);
        expect(typeof listing.total).toBe("number");
        expect(listing.events.some((row) => row.id === id.snapshot)).toBe(true);
      },
      SLOW,
    );

    it(
      "refuses a caller with no session at all",
      async () => {
        const anonymous = makeCaller(null);
        expect(await errorCode(anonymous.event.myStats())).toBe("UNAUTHORIZED");
        expect(await errorCode(anonymous.event.listAll({}))).toBe(
          "UNAUTHORIZED",
        );
      },
      SLOW,
    );
  });

  describe("event.update", () => {
    /**
     * Drizzle strips `undefined` out of the update set, so spreading the parsed
     * input straight into `.set()` drops every omitted optional key from the
     * UPDATE entirely: clearing a location or a description did nothing, the
     * mutation reported success, and the stale text kept rendering to members.
     * Omitted here means cleared, and only reading the row back proves it.
     */
    it(
      "writes NULL when description, location and maxCheckIns are omitted",
      async () => {
        const before = await readEvent(id.editable);
        expect(before?.description).not.toBeNull();
        expect(before?.location).not.toBeNull();
        expect(before?.maxCheckIns).not.toBeNull();

        await callerFor(admin).event.update({
          id: id.editable,
          title: "vitest editable, cleared",
          startsAt: new Date(),
          pointsValue: 12,
        });

        const after = await readEvent(id.editable);
        expect(after?.description).toBeNull();
        expect(after?.location).toBeNull();
        expect(after?.maxCheckIns).toBeNull();
        // The fields that were supplied still have to land.
        expect(after?.title).toBe("vitest editable, cleared");
        expect(after?.pointsValue).toBe(12);
      },
      SLOW,
    );

    it(
      "returns NOT_FOUND for an event that does not exist",
      async () => {
        expect(
          await errorCode(
            callerFor(admin).event.update({
              id: `vitest-missing-${suffix}`,
              title: "nothing",
              startsAt: new Date(),
              pointsValue: 1,
            }),
          ),
        ).toBe("NOT_FOUND");
      },
      SLOW,
    );
  });

  describe("member-facing output", () => {
    /**
     * `checkInCode` is a bearer credential: whoever reads one can check in from
     * anywhere. It leaks the moment somebody selects a whole event row into a
     * member query, which is invisible in a diff and invisible in the UI — the
     * value simply rides along in the payload. Asserted against the returned
     * objects rather than against the select list, because that is what
     * actually reaches the browser.
     */
    it(
      "never carries checkInCode in myEvents, myStats or upcoming",
      async () => {
        const caller = callerFor(statsMember);
        const [mine, stats, upcoming] = await Promise.all([
          caller.event.myEvents(),
          caller.event.myStats(),
          caller.event.upcoming(),
        ]);

        expect(mine.length).toBeGreaterThan(0);
        expect(upcoming.length).toBeGreaterThan(0);
        // The event this member attended is genuinely in both payloads, so the
        // assertions below are examining real rows rather than empty lists.
        expect(mine.some((row) => row.id === id.snapshot)).toBe(true);
        expect(upcoming.some((row) => row.id === id.snapshot)).toBe(true);

        for (const row of [...mine, ...upcoming, stats]) {
          expect(row).not.toHaveProperty("checkInCode");
        }

        const payload = JSON.stringify({ mine, stats, upcoming });
        for (const secret of allCodes) {
          expect(payload).not.toContain(secret);
        }
      },
      SLOW,
    );

    it(
      "keeps an archived event out of upcoming",
      async () => {
        const upcoming = await callerFor(statsMember).event.upcoming();
        expect(upcoming.some((row) => row.id === id.archived)).toBe(false);
      },
      SLOW,
    );
  });
});
