import {
  Column,
  getTableName,
  is,
  Param,
  SQL,
  StringChunk,
  Table,
} from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { eventCheckIns, users } from "../packages/db/src/schema";

/**
 * Unit coverage for packages/api/src/routers/member.ts, driven through the
 * router's own `createCaller` with a stub `db` that records the query builder
 * calls instead of running them. Nothing in this file opens a connection.
 *
 * Because no SQL executes, a claim about what the database WOULD return is
 * asserted against the query that was built — the left join, the escaped LIKE
 * pattern, the ORDER BY, the distinct count — rather than against rows this
 * file made up. The rows are only there to prove they survive the trip.
 *
 * Same import dance as tests/event-router.test.ts: tRPC config is frozen when
 * `@buzz/api/trpc` is first evaluated, so tests pin `NODE_ENV` to production.
 */
vi.mock("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

vi.stubEnv("NODE_ENV", "production");
const { createCaller } = await import("../packages/api/src/root");
const { escapeLikePattern } =
  await import("../packages/api/src/routers/member");
const { resetRateLimits } = await import("../packages/api/src/rate-limit");
vi.unstubAllEnvs();

type Ctx = Parameters<typeof createCaller>[0];

const CALLER_ID = "member-1";

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
      user: { id: CALLER_ID, role: "MEMBER", email: "member@gatech.edu" },
      expires: "2099-01-01T00:00:00.000Z",
    },
    headers: new Headers(),
  } as unknown as Ctx;
}

/**
 * Returns the rejection, or fails loudly if the call resolved instead.
 * Typed structurally so this file needs no dependency of its own.
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

/** Any touch is a failure: proves the gate ran before any query. */
const unreachableDb = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `db.${String(property)} was reached; the call should have been refused first`,
      );
    },
  },
);

const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
afterAll(() => consoleLog.mockRestore());

// ------------------------------------------------------------ SQL inspection

/** Renders a drizzle fragment to text; `?` stands in for a bound value. */
function sqlText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (is(value, SQL)) return value.queryChunks.map(sqlText).join("");
  if (is(value, SQL.Aliased))
    return `${sqlText(value.sql)} as ${value.fieldAlias}`;
  if (is(value, StringChunk)) return value.value.join("");
  if (is(value, Column)) return `${getTableName(value.table)}.${value.name}`;
  if (is(value, Table)) return getTableName(value);
  if (Array.isArray(value)) return value.map(sqlText).join(", ");
  return "?";
}

/**
 * Every value the driver would receive as a parameter. Note that drizzle only
 * wraps some of them in `Param` — `ilike(column, pattern)` leaves the pattern
 * as a bare string chunk, and the query builder binds it at the end — so
 * anything that is not a recognised fragment counts as bound.
 */
function boundValues(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  if (is(value, SQL)) return value.queryChunks.flatMap(boundValues);
  if (is(value, SQL.Aliased)) return boundValues(value.sql);
  if (is(value, Param)) return [value.value];
  if (is(value, StringChunk) || is(value, Column) || is(value, Table))
    return [];
  if (Array.isArray(value)) return value.flatMap(boundValues);
  return [value];
}

function tableName(value: unknown): string | undefined {
  return is(value, Table) ? getTableName(value) : undefined;
}

function fieldTexts(captures: Capture[]): string[] {
  return captures.flatMap((capture) =>
    Object.values(capture.fields ?? {}).map(sqlText),
  );
}

/** Postgres takes a backslash unless the query names another escape character. */
function escapeCharOf(text: string): string {
  return /escape\s+'(.+?)'/i.exec(text)?.[1] ?? "\\";
}

function unescapedWildcards(pattern: string, escapeChar: string): number {
  let found = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === escapeChar) {
      index++;
      continue;
    }
    if (pattern[index] === "%" || pattern[index] === "_") found++;
  }
  return found;
}

/** The bound patterns carrying `term`, whether or not it was escaped. */
function searchPatterns(
  capture: Capture,
  term: string,
  escapeChar: string,
): string[] {
  return boundValues(capture.where).filter(
    (value): value is string =>
      typeof value === "string" &&
      value.split(escapeChar).join("").includes(term),
  );
}

// ----------------------------------------------------------------- stub db

type Capture = {
  fields: Record<string, unknown> | undefined;
  from: unknown;
  joins: { kind: string; table: unknown }[];
  where: unknown;
  having: unknown;
  groupBy: unknown[];
  orderBy: unknown[];
  limit: number | undefined;
  offset: number | undefined;
  distinct: boolean;
  counted: boolean;
};

type Chain = {
  from: (table: unknown) => Chain;
  leftJoin: (table: unknown, on?: unknown) => Chain;
  innerJoin: (table: unknown, on?: unknown) => Chain;
  where: (condition: unknown) => Chain;
  having: (condition: unknown) => Chain;
  groupBy: (...columns: unknown[]) => Chain;
  orderBy: (...columns: unknown[]) => Chain;
  limit: (rows: number) => Chain;
  offset: (rows: number) => Chain;
  as: (alias: string) => unknown;
  then: (
    resolve: (rows: unknown) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise<unknown>;
};

/**
 * A `db` that records each query instead of running it and answers with
 * whatever `answer` decides. The builder is thenable, like drizzle's own, so
 * the router awaits it exactly as it would in production.
 */
function selectCapturingDb(
  answer: (capture: Capture) => unknown,
  query: Record<string, unknown> = {},
) {
  const captures: Capture[] = [];

  function open(options: Partial<Capture> = {}) {
    const capture: Capture = {
      fields: undefined,
      from: undefined,
      joins: [],
      where: undefined,
      having: undefined,
      groupBy: [],
      orderBy: [],
      limit: undefined,
      offset: undefined,
      distinct: false,
      counted: false,
      ...options,
    };
    captures.push(capture);
    return capture;
  }

  function chainFor(capture: Capture): Chain {
    const chain: Chain = {
      from: (table) => {
        capture.from = table;
        return chain;
      },
      leftJoin: (table) => {
        capture.joins.push({ kind: "left", table });
        return chain;
      },
      innerJoin: (table) => {
        capture.joins.push({ kind: "inner", table });
        return chain;
      },
      where: (condition) => {
        capture.where = condition;
        return chain;
      },
      having: (condition) => {
        capture.having = condition;
        return chain;
      },
      groupBy: (...columns) => {
        capture.groupBy = columns;
        return chain;
      },
      orderBy: (...columns) => {
        capture.orderBy = columns;
        return chain;
      },
      limit: (rows) => {
        capture.limit = rows;
        return chain;
      },
      offset: (rows) => {
        capture.offset = rows;
        return chain;
      },
      // Mirror drizzle subqueries: `.as("alias")` returns the selected columns
      // so later `sum(live.pointsEarned)` still resolves to real column refs.
      as: () => ({ ...(capture.fields ?? {}), capture }),
      then: (resolve, reject) =>
        Promise.resolve()
          .then(() => answer(capture))
          .then(resolve, reject),
    };
    return chain;
  }

  const db = {
    select: (fields?: Record<string, unknown>) => chainFor(open({ fields })),
    selectDistinct: (fields?: Record<string, unknown>) =>
      chainFor(open({ fields, distinct: true })),
    $count: (source: unknown, where?: unknown) => {
      const capture = open({ from: source, where, counted: true });
      return Promise.resolve().then(() => Number(answer(capture)));
    },
    $with: (alias: string) => ({ as: (value: unknown) => ({ alias, value }) }),
    with: () => db,
    query,
  };

  return { db, captures };
}

function pick(
  row: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
}

// ------------------------------------------------------- escapeLikePattern

describe("escapeLikePattern", () => {
  it("neutralises every LIKE metacharacter", () => {
    expect(escapeLikePattern("100%")).toBe("100\\%");
    expect(escapeLikePattern("a_b")).toBe("a\\_b");
    expect(escapeLikePattern("%_%")).toBe("\\%\\_\\%");
  });

  /**
   * One pass, not one per character class. Escaping `%` and then escaping
   * backslashes turns the `\%` just added into `\\%` — a literal backslash
   * followed by a live wildcard, which is both wrong and still a wildcard.
   */
  it("escapes the escape character without escaping its own output", () => {
    expect(escapeLikePattern("50%\\")).toBe("50\\%\\\\");
    expect(escapeLikePattern("\\")).toBe("\\\\");
  });

  it("leaves a search term with nothing to escape untouched", () => {
    expect(escapeLikePattern("grace@gatech.edu")).toBe("grace@gatech.edu");
  });
});

// -------------------------------------------------------------- member.list

/** One aggregate is the row count; anything wider is the page of members. */
function isTotalQuery(capture: Capture): boolean {
  const keys = Object.keys(capture.fields ?? {});
  return capture.counted || (keys.length === 1 && !keys.includes("id"));
}

function rowQuery(captures: Capture[]): Capture {
  const capture = captures.find(
    (candidate) =>
      !isTotalQuery(candidate) &&
      tableName(candidate.from) === getTableName(users),
  );
  if (!capture) throw new Error("list never selected a page of users");
  return capture;
}

function totalQuery(captures: Capture[]): Capture {
  const capture = captures.find(isTotalQuery);
  if (!capture) throw new Error("list never counted the matching members");
  return capture;
}

function listDb(rows: Record<string, unknown>[], total: number) {
  return selectCapturingDb((capture) => {
    if (!isTotalQuery(capture)) return rows;
    const [key] = Object.keys(capture.fields ?? {});
    return key === undefined ? total : [{ [key]: total }];
  });
}

/** The ORDER BY the page of members was read with, as text. */
function orderOf(captures: Capture[]): string {
  return rowQuery(captures).orderBy.map(sqlText).join(", ");
}

type ListInput = Parameters<
  ReturnType<typeof createCaller>["member"]["list"]
>[0];

/** The input type has no room for a sort outside the enum; that is the test. */
function listInput(input: Record<string, unknown>): ListInput {
  return input;
}

const REGULAR = {
  id: "member-2",
  name: "Grace Hopper",
  email: "grace@gatech.edu",
  role: "MEMBER",
  totalPoints: 30,
  totalEvents: 4,
  // The string `to_char` emits, not a Date: handing back a Date would let the
  // router drop its parse and still pass.
  lastCheckInAt: "2026-03-02T18:00:00Z",
};

const LAST_LISTED_CHECK_IN = new Date("2026-03-02T18:00:00.000Z");

const NEWCOMER = {
  id: "member-3",
  name: null,
  email: "newcomer@gatech.edu",
  role: "MEMBER",
  totalPoints: 0,
  totalEvents: 0,
  lastCheckInAt: null,
};

describe("member.list", () => {
  /**
   * The roster is the officers' only view of who has signed up, so somebody
   * who has not been to an event yet is exactly the person they are looking
   * for. An inner join drops them from the result set entirely, and `sum()`
   * over no rows is null rather than 0, so both have to be right in the query
   * — nothing downstream can put back a row the database never sent.
   */
  it("keeps a member with no check-ins, at zero rather than absent", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    const result = await createCaller(adminCtx(db)).member.list({});

    const newcomer = result.members.find(
      (member) => member.email === NEWCOMER.email,
    );
    expect(newcomer).toBeDefined();
    expect(newcomer!.totalPoints).toBe(0);
    expect(newcomer!.totalEvents).toBe(0);
    expect(newcomer!.lastCheckInAt).toBeNull();

    const regular = result.members.find(
      (member) => member.email === REGULAR.email,
    );
    expect(regular!.lastCheckInAt).toEqual(LAST_LISTED_CHECK_IN);

    const inner = rowQuery(captures).joins.filter(
      (join) =>
        join.kind === "inner" &&
        tableName(join.table) === getTableName(eventCheckIns),
    );
    expect(inner).toEqual([]);

    // Null sums are coerced with `asInt` in the router (not SQL coalesce) so
    // the query stays pure Drizzle aggregates.
    const sums = fieldTexts(captures).filter((text) => /sum\(/i.test(text));
    expect(sums.length).toBeGreaterThan(0);

    // count(*) under the left join returns 1 for a member with no check-ins,
    // reporting them as having attended one event. The stub cannot see that,
    // so the expression itself is what gets asserted.
    const counts = Object.values(rowQuery(captures).fields ?? {})
      .map(sqlText)
      .filter((text) => /count\s*\(/i.test(text));
    expect(counts.length).toBeGreaterThan(0);
    for (const text of counts) expect(text).not.toMatch(/count\s*\(\s*\*\s*\)/);
  });

  /**
   * `%` is the LIKE wildcard. Passed through unescaped, an officer searching
   * for the member who wrote "100%" in their name gets the entire chapter
   * back, and the count beside it agrees, so nothing about the screen looks
   * wrong.
   */
  it("escapes a percent sign in the search instead of matching everyone", async () => {
    const { db, captures } = listDb([], 0);
    await createCaller(adminCtx(db)).member.list({ search: "100%" });

    const capture = rowQuery(captures);
    const escapeChar = escapeCharOf(sqlText(capture.where));
    const patterns = searchPatterns(capture, "100%", escapeChar);

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toContain(`${escapeChar}%`);
      // Only the two the substring search wraps around the term may survive.
      expect(unescapedWildcards(pattern, escapeChar)).toBeLessThanOrEqual(2);
    }

    // The count has to carry the same predicate, or the total describes the
    // whole chapter while the rows below it describe a search.
    expect(
      searchPatterns(totalQuery(captures), "100%", escapeChar).length,
    ).toBeGreaterThan(0);
  });

  /** `_` is the single-character wildcard, and it is quieter than `%`. */
  it("escapes an underscore so a search for a_b does not match axb", async () => {
    const { db, captures } = listDb([], 0);
    await createCaller(adminCtx(db)).member.list({ search: "a_b" });

    const capture = rowQuery(captures);
    const escapeChar = escapeCharOf(sqlText(capture.where));
    const patterns = searchPatterns(capture, "a_b", escapeChar);

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toContain(`${escapeChar}_`);
      expect(unescapedWildcards(pattern, escapeChar)).toBeLessThanOrEqual(2);
    }

    expect(
      searchPatterns(totalQuery(captures), "a_b", escapeChar).length,
    ).toBeGreaterThan(0);
  });

  /**
   * Points alone is not a total order — everyone on zero ties. Postgres is
   * free to return a tied group in a different order per query, so without a
   * unique tiebreak a paging officer sees some members twice and never sees
   * others at all.
   */
  it("breaks a points tie on email so paging cannot repeat a member", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    await createCaller(adminCtx(db)).member.list({});

    const order = rowQuery(captures).orderBy.map(sqlText).join(", ");
    const pointsAt = order.search(/points/i);
    const emailAt = order.search(/email/i);

    expect(pointsAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeGreaterThan(pointsAt);
    expect(order.slice(0, emailAt)).toMatch(/desc/i);
    expect(order.slice(emailAt)).not.toMatch(/desc/i);
  });

  /** Today's ordering is the default one, and nothing about it may move. */
  it("sorts by points, then email, when no sort is asked for", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    await createCaller(adminCtx(db)).member.list({});
    const fallback = orderOf(captures);

    const pointsAt = fallback.search(/points/i);
    const emailAt = fallback.search(/email/i);
    expect(pointsAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeGreaterThan(pointsAt);
    expect(fallback.slice(0, emailAt)).toMatch(/desc/i);
    expect(fallback.slice(emailAt)).not.toMatch(/desc/i);

    const asked = listDb([REGULAR, NEWCOMER], 2);
    await createCaller(adminCtx(asked.db)).member.list({ sort: "points" });
    expect(orderOf(asked.captures)).toBe(fallback);
  });

  /**
   * NULLS LAST is the whole of this test. Postgres sorts nulls FIRST on a
   * descending order, so without it the roster opens with every member who has
   * never checked in — exactly backwards for a sort about recent activity.
   */
  it("sorts by the most recent check-in, with members who never came last", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    await createCaller(adminCtx(db)).member.list({ sort: "recent" });

    const order = orderOf(captures);
    const checkedInAt = order.search(/check.{0,3}in.{0,3}at/i);
    const emailAt = order.search(/email/i);

    expect(checkedInAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeGreaterThan(checkedInAt);
    expect(order.slice(0, emailAt)).toMatch(/desc/i);
    // `(checkedInAt IS NULL) ASC` before the DESC puts never-checked-in last.
    expect(order.slice(0, emailAt)).toMatch(/is\s+null/i);
    expect(order.slice(emailAt)).not.toMatch(/desc/i);
  });

  /** A member who has never filled in a name sorts last, not first. */
  it("sorts by name ascending, with the unnamed last, then email", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    await createCaller(adminCtx(db)).member.list({ sort: "name" });

    const order = orderOf(captures);
    const nameAt = order.search(/name/i);
    const emailAt = order.search(/email/i);

    expect(nameAt).toBeGreaterThanOrEqual(0);
    expect(emailAt).toBeGreaterThan(nameAt);
    expect(order.slice(0, emailAt)).toMatch(/is\s+null/i);
    expect(order.slice(0, emailAt)).not.toMatch(/desc/i);
  });

  /** An unknown sort is a rejected request, not a silent fall back to points. */
  it("refuses a sort outside the three it knows", async () => {
    const error = await rejection(
      createCaller(adminCtx(unreachableDb)).member.list(
        listInput({ sort: "attendance" }),
      ),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  /**
   * The total is a count of members, not of the joined check-in rows. Get it
   * wrong and the busiest chapter reports several hundred more members than
   * it has, and the last page of the roster is empty.
   */
  it("counts each member once however many check-ins they have", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 2);
    const result = await createCaller(adminCtx(db)).member.list({});

    expect(result.total).toBe(2);

    const capture = totalQuery(captures);
    const joinsCheckIns = capture.joins.some(
      (join) => tableName(join.table) === getTableName(eventCheckIns),
    );
    const expression = Object.values(capture.fields ?? {})
      .map(sqlText)
      .join(" ");
    const countsRowsNotMembers =
      joinsCheckIns && !capture.distinct && !/distinct/i.test(expression);

    expect(countsRowsNotMembers).toBe(false);
  });

  it("pages with the offset and limit it was given", async () => {
    const { db, captures } = listDb([REGULAR, NEWCOMER], 57);
    const result = await createCaller(adminCtx(db)).member.list({
      limit: 10,
      offset: 40,
    });

    const capture = rowQuery(captures);
    expect(capture.limit).toBe(10);
    expect(capture.offset).toBe(40);
    // The total is what the count query said, not the length of this page.
    expect(result.total).toBe(57);
  });

  it("takes the first 25 when no page is asked for", async () => {
    const { db, captures } = listDb([REGULAR], 1);
    await createCaller(adminCtx(db)).member.list({});

    const capture = rowQuery(captures);
    expect(capture.limit).toBe(25);
    expect(capture.offset).toBe(0);
  });

  /** The page size is a cost the database pays, so the caller cannot pick it. */
  it("refuses a page size past 100 and accepts exactly 100", async () => {
    const caller = () => createCaller(adminCtx(unreachableDb)).member;

    expect((await rejection(caller().list({ limit: 101 }))).code).toBe(
      "BAD_REQUEST",
    );
    expect((await rejection(caller().list({ limit: 0 }))).code).toBe(
      "BAD_REQUEST",
    );
    expect((await rejection(caller().list({ offset: -1 }))).code).toBe(
      "BAD_REQUEST",
    );

    const { db, captures } = listDb([REGULAR], 1);
    await createCaller(adminCtx(db)).member.list({ limit: 100 });
    expect(rowQuery(captures).limit).toBe(100);
  });

  /** Every other member's email address is on this screen. */
  it("is refused to a member who is not an officer", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).member.list({}),
    );
    expect(error.code).toBe("FORBIDDEN");
  });
});

// ------------------------------------------------------- member.exportRoster

function exportDb(rows: Record<string, unknown>[]) {
  return selectCapturingDb((capture) =>
    rows.map((row) => pick(row, capture.fields)),
  );
}

describe("member.exportRoster", () => {
  /**
   * The same wildcard as `list`, and less visible here: an unescaped `%` writes
   * the entire chapter into the file, and the file looks exactly right.
   */
  it("escapes a percent sign instead of exporting the whole chapter", async () => {
    resetRateLimits();
    const { db, captures } = exportDb([]);
    await createCaller(adminCtx(db)).member.exportRoster({ search: "100%" });

    const capture = rowQuery(captures);
    const escapeChar = escapeCharOf(sqlText(capture.where));
    const patterns = searchPatterns(capture, "100%", escapeChar);

    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(pattern).toContain(`${escapeChar}%`);
      expect(unescapedWildcards(pattern, escapeChar)).toBeLessThanOrEqual(2);
    }
  });

  /** An export of the 25 rows on screen is not an export of the roster. */
  it("takes the whole roster rather than the page on screen", async () => {
    resetRateLimits();
    const { db, captures } = exportDb([REGULAR, NEWCOMER]);
    const result = await createCaller(adminCtx(db)).member.exportRoster({});

    expect(rowQuery(captures).limit).toBe(5000);
    expect(result.members).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.members[0]!.lastCheckInAt).toEqual(LAST_LISTED_CHECK_IN);
    expect(result.members[1]!.lastCheckInAt).toBeNull();
  });

  /**
   * This one leaves the building as a file. An internal id in a spreadsheet is
   * a liability that never comes back, and nothing downstream reads one.
   */
  it("carries no internal id into the spreadsheet", async () => {
    resetRateLimits();
    const { db } = exportDb([REGULAR, NEWCOMER]);
    const result = await createCaller(adminCtx(db)).member.exportRoster({});

    const keys = [
      ...new Set(result.members.flatMap((member) => Object.keys(member))),
    ].sort();
    expect(keys).toEqual([
      "email",
      "lastCheckInAt",
      "name",
      "role",
      "totalEvents",
      "totalPoints",
    ]);
  });

  /** Every member's email address, in one file. */
  it("is refused to a member who is not an officer", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).member.exportRoster({}),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

// -------------------------------------------------------------- member.byId

const FIRST_CHECK_IN = new Date("2025-09-04T23:00:00.000Z");
const SECOND_CHECK_IN = new Date("2025-11-12T23:30:00.000Z");
const LAST_CHECK_IN = new Date("2026-02-18T23:00:00.000Z");

const PROFILE = {
  id: "member-2",
  name: "Grace Hopper",
  email: "grace@gatech.edu",
  role: "MEMBER",
  image: null,
  totalPoints: 30,
  totalEvents: 3,
  memberSince: "2025-09-04T23:00:00Z",
};

/** Newest first, as the query orders it. */
const HISTORY = [
  {
    eventId: "event-9",
    title: "Spring Social",
    startsAt: new Date("2026-02-18T22:00:00.000Z"),
    location: "Klaus 1443",
    pointsEarned: 10,
    method: "code",
    checkedInAt: LAST_CHECK_IN,
  },
  {
    eventId: "event-5",
    title: "Resume Workshop",
    startsAt: new Date("2025-11-12T22:30:00.000Z"),
    location: null,
    pointsEarned: 15,
    method: "manual",
    checkedInAt: SECOND_CHECK_IN,
  },
  {
    eventId: "event-1",
    title: "Fall Kickoff",
    startsAt: new Date("2025-09-04T22:00:00.000Z"),
    location: "Klaus Atrium",
    pointsEarned: 5,
    method: "code",
    checkedInAt: FIRST_CHECK_IN,
  },
];

function byIdDb(
  member: Record<string, unknown> | undefined,
  history: Record<string, unknown>[],
) {
  return selectCapturingDb(
    (capture) => {
      const keys = Object.keys(capture.fields ?? {});
      const isHistory = ["pointsEarned", "method", "title"].some((key) =>
        keys.includes(key),
      );
      if (isHistory) return history;
      return member === undefined ? [] : [pick(member, capture.fields)];
    },
    { users: { findFirst: () => Promise.resolve(member) } },
  );
}

describe("member.byId", () => {
  it("answers a member id that matches nothing with NOT_FOUND", async () => {
    const { db } = byIdDb(undefined, []);
    const error = await rejection(
      createCaller(adminCtx(db)).member.byId({ id: "nobody" }),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("Member not found.");
  });

  /**
   * There is no createdAt on users, so "member since" can only be the first
   * event they turned up to. Reading it off the front of a newest-first
   * history — or aggregating with max() — dates every member from their most
   * recent event instead, which reads as though they joined last week.
   */
  it("dates memberSince from the earliest check-in, not the latest", async () => {
    const { db, captures } = byIdDb(PROFILE, HISTORY);
    const result = await createCaller(adminCtx(db)).member.byId({
      id: PROFILE.id,
    });

    expect(result.memberSince).toEqual(FIRST_CHECK_IN);
    expect(result.memberSince).not.toEqual(LAST_CHECK_IN);

    const overCheckedInAt = fieldTexts(captures).filter(
      (text) => /checkedinat/i.test(text) && /\b(min|max)\s*\(/i.test(text),
    );
    for (const text of overCheckedInAt) expect(text).not.toMatch(/max\s*\(/i);
  });

  /**
   * More sensitive than the roster: one member's email, their photo, and every
   * event they have been to. A downgrade to protectedProcedure would hand that
   * to any signed-in member holding an id.
   */
  it("is refused to a member who is not an officer", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).member.byId({ id: "member-2" }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

// ------------------------------------------------------- member.leaderboard

/**
 * A ranking the database would produce: two members tied on 30 points share
 * rank 2, and the next member is rank 4 rather than 3. Every row carries the
 * columns a leak would come from, so a query that selects them shows up in
 * the privacy test rather than passing for want of the data.
 */
const RANKED = [
  {
    id: "member-9",
    name: "Ada Lovelace",
    email: "ada@gatech.edu",
    image: "https://example.invalid/ada.jpg",
    rank: 1,
    totalPoints: 40,
    totalEvents: 5,
    isYou: false,
  },
  {
    id: "member-8",
    name: "Katherine Johnson",
    email: "katherine@gatech.edu",
    image: null,
    rank: 2,
    totalPoints: 30,
    totalEvents: 4,
    isYou: false,
  },
  {
    id: "member-7",
    name: "Mary Jackson",
    email: "mary@gatech.edu",
    image: null,
    rank: 2,
    totalPoints: 30,
    totalEvents: 4,
    isYou: false,
  },
  {
    id: "member-6",
    name: "Grace Hopper",
    email: "grace@gatech.edu",
    image: null,
    rank: 4,
    totalPoints: 20,
    totalEvents: 3,
    isYou: false,
  },
];

const CALLER_ROW = {
  id: CALLER_ID,
  name: "Jamie Chen",
  email: "jamie@gatech.edu",
  image: null,
  rank: 9,
  totalPoints: 6,
  totalEvents: 2,
  isYou: true,
};

/**
 * Answers the single ordered board query. The router ranks in JavaScript and
 * slices to `limit`, so the stub returns every row (with `userId` aliased from
 * `id` to match the select shape).
 */
function leaderboardDb(ranked: Record<string, unknown>[]) {
  return selectCapturingDb((capture) => {
    const rows = ranked.map((row) => ({
      ...row,
      userId: row.userId ?? row.id,
    }));
    return rows.map((row) => pick(row, capture.fields));
  });
}

describe("member.leaderboard", () => {
  /**
   * Competition ranks in the router (ties share a place; the next place is
   * skipped). Ordering is Postgres; ranking is applied after the fetch so we
   * do not need window-function SQL.
   */
  it("shares a rank between ties and skips the rank they used up", async () => {
    const { db, captures } = leaderboardDb(RANKED);
    const result = await createCaller(memberCtx(db)).member.leaderboard({
      limit: 4,
    });

    expect(result.top.map((row) => row.rank)).toEqual([1, 2, 2, 4]);

    // No window function in the query — ranks are derived from the ordered rows.
    const ranking = fieldTexts(captures).filter((text) =>
      /rank\(\)|row_number\(\)/i.test(text),
    );
    expect(ranking).toEqual([]);
  });

  it("reports no standing for a member who has never checked in", async () => {
    const { db, captures } = leaderboardDb(RANKED);
    const result = await createCaller(memberCtx(db)).member.leaderboard({
      limit: 3,
    });

    expect(result.you).toBeNull();

    // Inner join on check-ins: a left join would rank every signed-in member.
    const board = captures.find((capture) =>
      capture.joins.some(
        (join) => tableName(join.table) === getTableName(eventCheckIns),
      ),
    );
    expect(board).toBeDefined();
    const checkInJoins = board!.joins.filter(
      (join) => tableName(join.table) === getTableName(eventCheckIns),
    );
    expect(checkInJoins.length).toBeGreaterThan(0);
    for (const join of checkInJoins) expect(join.kind).toBe("inner");
  });

  /**
   * The whole point of the pinned row: the members who most need to see where
   * they stand are the ones the board does not reach.
   */
  it("still reports the caller's standing from outside the top N", async () => {
    const { db } = leaderboardDb([...RANKED, CALLER_ROW]);
    const result = await createCaller(memberCtx(db)).member.leaderboard({
      limit: 3,
    });

    expect(result.top).toHaveLength(3);
    expect(result.top.map((row) => row.name)).not.toContain(CALLER_ROW.name);
    // Competition rank over the stub set: 40,30,30,20,6 → places 1,2,2,4,5.
    expect(result.you).toEqual({ rank: 5, totalPoints: 6, totalEvents: 2 });
  });

  /**
   * This is the one screen where members see data about other members, and
   * membership is free — anyone who signs in can call it. A name and a number
   * is the whole of what the board is for; an email address on it is a leak
   * of every member's contact details to every member.
   */
  it("carries a name and totals only, never an email, id or image", async () => {
    const { db } = leaderboardDb([...RANKED, CALLER_ROW]);
    const result = await createCaller(memberCtx(db)).member.leaderboard({
      limit: 5,
    });

    expect(result.top.length).toBeGreaterThan(0);
    const keys = [
      ...new Set(result.top.flatMap((row) => Object.keys(row))),
    ].sort();
    expect(keys).toEqual([
      "isYou",
      "name",
      "rank",
      "totalEvents",
      "totalPoints",
    ]);
  });
});
