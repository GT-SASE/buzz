import {
  asc,
  Column,
  desc,
  getTableName,
  is,
  Param,
  SQL,
  StringChunk,
  Table,
} from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

import { eventCheckIns, events, users } from "../packages/db/src/schema";

/**
 * Unit coverage for packages/api/src/routers/chapter.ts, driven through the
 * router's own `createCaller` with a stub `db` that records the query it was
 * asked to run and answers as Postgres would have. Nothing here opens a
 * connection.
 *
 * Same harness as tests/member-router.test.ts, duplicated rather than shared
 * because that file exports nothing, plus a relational `query.events.findFirst`
 * path so either way of reading nextEvent is answered.
 *
 * Same import dance too: tRPC config is frozen when `@buzz/api/trpc` is first
 * evaluated, so tests pin `NODE_ENV` to production.
 */
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

/** The relational builder takes `(fields, operators) => ...` as well as SQL. */
function orderText(value: unknown): string {
  if (typeof value === "function") {
    const build = value as (fields: unknown, operators: unknown) => unknown;
    try {
      return sqlText(build(events, { asc, desc }));
    } catch {
      return "";
    }
  }
  return sqlText(value);
}

const CHECK_INS = getTableName(eventCheckIns);
const EVENTS = getTableName(events);
const USERS = getTableName(users);

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

type EventRow = {
  id: string;
  title: string;
  startsAt: Date;
  location: string | null;
  checkInEnabled: boolean;
  currentCheckIns: number;
  maxCheckIns: number | null;
  /** A bearer credential. Present so a query that selects it is visible. */
  checkInCode: string;
  archivedAt: Date | null;
};

/** The chapter as the database would answer it, one number per definition. */
type World = {
  members: number;
  membersWithCheckIns: number;
  checkIns: number;
  checkInsLast30: number;
  /** Every event row, archived included. */
  events: number;
  /** Non-archived only, whatever their date. */
  liveEvents: number;
  pastEvents: number;
  upcomingEvents: number;
  /** Check-ins at past non-archived events. */
  pastCheckIns: number;
  upcoming: EventRow[];
  /** Past countable events for `chapter.attendance` series queries. */
  series?: EventRow[];
};

type Subject = "members" | "membersWithCheckIns" | "checkIns" | "events";

/** What a fragment restricts itself to, read off the SQL it built. */
function scopeOf(text: string) {
  return {
    past: /starts.{0,3}at\s*<=?\s*\?/i.test(text),
    upcoming: /starts.{0,3}at\s*>=?\s*\?/i.test(text),
    recent: /check.{0,3}in.{0,3}at\s*>=?\s*\?/i.test(text),
    liveOnly: /archived.{0,3}at\s+is\s+null/i.test(text),
  };
}

function textSubject(text: string): Subject | undefined {
  // Longest table name first: `buzz_event` is a prefix of `buzz_event_check_in`.
  if (text.includes(CHECK_INS)) return "checkIns";
  if (text.includes(EVENTS)) return "events";
  if (text.includes(USERS)) return "members";
  return undefined;
}

function tableSubject(name: string | undefined): Subject | undefined {
  if (name === CHECK_INS) return "checkIns";
  if (name === EVENTS) return "events";
  if (name === USERS) return "members";
  return undefined;
}

function subjectFor(
  key: string,
  text: string,
  from: unknown,
): Subject | undefined {
  const name = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (/withcheckins|attended|activemembers|uniquemembers/.test(name))
    return "membersWithCheckIns";
  // `count(distinct check_ins.userId)` is the members who attended something;
  // `count(distinct users.id)` is simply every member.
  if (
    /distinct/i.test(text) &&
    text.includes(CHECK_INS) &&
    /user.{0,3}id/i.test(text)
  )
    return "membersWithCheckIns";
  if (name.includes("checkin")) return "checkIns";
  if (name.includes("event")) return "events";
  if (/member|user|people/.test(name)) return "members";
  return textSubject(text) ?? tableSubject(tableName(from));
}

/**
 * Postgres over the same rows: null over an empty set, and `round(x, n)` and
 * `coalesce` applied only when the query actually asked for them.
 */
function averageOf(text: string, world: World): number | null {
  const mean =
    world.pastEvents === 0 ? null : world.pastCheckIns / world.pastEvents;
  if (mean === null) return /coalesce\s*\(/i.test(text) ? 0 : null;
  if (!/round\s*\(/i.test(text)) return mean;
  const places = Number(/round\s*\(.*?,\s*(\d+)\s*\)/is.exec(text)?.[1] ?? 0);
  const factor = 10 ** places;
  return Math.round(mean * factor) / factor;
}

function valueFor(
  key: string,
  text: string,
  capture: Capture,
  world: World,
): unknown {
  if (/\bavg\s*\(/i.test(text) || /average|mean/i.test(key))
    return averageOf(text, world);

  const scope = scopeOf(`${text} ${sqlText(capture.where)}`);
  switch (subjectFor(key, text, capture.from)) {
    case "events":
      if (scope.past) return world.pastEvents;
      if (scope.upcoming) return world.upcomingEvents;
      return scope.liveOnly ? world.liveEvents : world.events;
    case "checkIns":
      if (scope.past) return world.pastCheckIns;
      if (scope.recent) return world.checkInsLast30;
      return world.checkIns;
    case "members":
      return world.members;
    case "membersWithCheckIns":
      return world.membersWithCheckIns;
    default:
      throw new Error(
        `the stub cannot tell what "${key}" (${text}) counts; teach chapterDb about it`,
      );
  }
}

function pick(
  row: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (fields === undefined) return { ...row };
  return Object.fromEntries(Object.keys(fields).map((key) => [key, row[key]]));
}

function isEventRowQuery(capture: Capture): boolean {
  const keys = Object.keys(capture.fields ?? {});
  return keys.includes("title") || keys.includes("startsAt");
}

/** Rows in the order the query asked for them — unordered stays unordered. */
function orderedEvents(capture: Capture, world: World): EventRow[] {
  const order = capture.orderBy.map(orderText).join(", ");
  const rows = /starts.{0,3}at/i.test(order)
    ? [...world.upcoming].sort(
        (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
      )
    : [...world.upcoming];
  if (/\bdesc\b/i.test(order)) rows.reverse();
  return rows.slice(0, capture.limit ?? rows.length);
}

type FindFirstConfig = {
  where?: unknown;
  orderBy?: unknown;
  columns?: Record<string, unknown>;
};

function chapterDb(world: World) {
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

  function answer(capture: Capture): unknown {
    if (capture.counted) return valueFor("total", "", capture, world);
    if (isEventRowQuery(capture)) {
      // `chapter.attendance` groups past events newest-first; `overview`
      // nextEvent is the same shape with limit 1.
      if (capture.groupBy.length > 0 && capture.limit !== 1) {
        return (world.series ?? []).map((row) => ({
          ...pick(row, capture.fields),
          checkIns: row.currentCheckIns,
        }));
      }
      return orderedEvents(capture, world).map((row) =>
        pick(row, capture.fields),
      );
    }

    const fields = capture.fields;
    if (fields === undefined)
      throw new Error("the stub cannot answer a select with no fields");

    return [
      Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [
          key,
          valueFor(key, sqlText(field), capture, world),
        ]),
      ),
    ];
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
      as: () => ({ capture }),
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
    query: {
      events: {
        findFirst: (config: FindFirstConfig = {}) => {
          const capture = open({
            from: events,
            where: config.where,
            orderBy: config.orderBy === undefined ? [] : [config.orderBy],
            limit: 1,
          });
          const [row] = orderedEvents(capture, world);
          return Promise.resolve(
            row === undefined ? undefined : pick(row, config.columns),
          );
        },
      },
    },
  };

  return { db, captures };
}

function everyText(captures: Capture[]): string[] {
  return captures.map((capture) =>
    [...Object.values(capture.fields ?? {}), capture.where, capture.having]
      .map(sqlText)
      .join(" "),
  );
}

/** Captures that restrict themselves to events that have already started. */
function pastScoped(captures: Capture[]): Capture[] {
  const texts = everyText(captures);
  return captures.filter((_capture, index) => scopeOf(texts[index] ?? "").past);
}

// -------------------------------------------------------------- the fixtures

const UPCOMING: EventRow[] = [
  // Deliberately furthest-first: a resolver that never orders at all hands
  // back whatever the database returned first, and that is this row.
  {
    id: "event-31",
    title: "Industry Night",
    startsAt: new Date("2026-11-05T23:00:00.000Z"),
    location: "Klaus 1443",
    checkInEnabled: false,
    currentCheckIns: 0,
    maxCheckIns: 60,
    checkInCode: "MNPQ2345",
    archivedAt: null,
  },
  {
    id: "event-29",
    title: "Fall Kickoff",
    startsAt: new Date("2026-09-03T22:00:00.000Z"),
    location: "Klaus Atrium",
    checkInEnabled: true,
    currentCheckIns: 4,
    maxCheckIns: null,
    checkInCode: "ABCD2345",
    archivedAt: null,
  },
  {
    id: "event-30",
    title: "Resume Workshop",
    startsAt: new Date("2026-10-01T22:30:00.000Z"),
    location: null,
    checkInEnabled: true,
    currentCheckIns: 11,
    maxCheckIns: 40,
    checkInCode: "EFGH2345",
    archivedAt: null,
  },
];

const SOONEST = UPCOMING[1]!;

/** 31 events, 4 of them archived; 396 check-ins over 24 past events. */
const CHAPTER: World = {
  members: 128,
  membersWithCheckIns: 74,
  checkIns: 412,
  checkInsLast30: 63,
  events: 31,
  liveEvents: 27,
  pastEvents: 24,
  upcomingEvents: 3,
  pastCheckIns: 396,
  upcoming: UPCOMING,
};

// ------------------------------------------------------------- ticking clock

const RealDate = Date;
let clockCursor: number | null = null;
const CLOCK_STEP_MS = 60_000;

function tick(): number {
  if (clockCursor === null) return RealDate.now();
  clockCursor += CLOCK_STEP_MS;
  return clockCursor;
}

/**
 * Every reading of the clock lands a minute after the last one, so a resolver
 * that calls `new Date()` once per query binds visibly different instants
 * instead of three copies of the same millisecond.
 */
class TickingDate extends Date {
  constructor(value?: number | string | Date) {
    super(value ?? tick());
  }
  static now(): number {
    return tick();
  }
}

async function underTickingClock<T>(run: () => Promise<T>): Promise<T> {
  clockCursor = new RealDate("2026-04-01T15:00:00.000Z").getTime();
  globalThis.Date = TickingDate as unknown as DateConstructor;
  try {
    return await run();
  } finally {
    globalThis.Date = RealDate;
    clockCursor = null;
  }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------- chapter.overview

describe("chapter.overview", () => {
  it("reports every total the officer dashboard reads", async () => {
    const { db } = chapterDb(CHAPTER);
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.members).toEqual({ total: 128, withCheckIns: 74 });
    expect(result.checkIns).toEqual({ total: 412, last30Days: 63 });
    // Live events only — archived rows are out of every overview figure.
    expect(result.events.total).toBe(27);
    expect(result.events.past).toBe(24);
    expect(result.events.upcoming).toBe(3);
    expect(result.events.averageAttendance).toBe(16.5);
  });

  /**
   * The division guard. No past events means no denominator, and NaN or null
   * reaching the dashboard renders as a blank or "NaN" beside a real number.
   */
  it("reports an average of 0, not NaN, before any event has happened", async () => {
    const { db } = chapterDb({
      members: 12,
      membersWithCheckIns: 0,
      checkIns: 0,
      checkInsLast30: 0,
      events: 2,
      liveEvents: 2,
      pastEvents: 0,
      upcomingEvents: 2,
      pastCheckIns: 0,
      upcoming: UPCOMING.slice(0, 2),
    });
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.events.averageAttendance).toBe(0);
    expect(Number.isNaN(result.events.averageAttendance)).toBe(false);
    expect(result.events.averageAttendance).not.toBeNull();
  });

  it("rounds averageAttendance to one decimal place", async () => {
    const { db } = chapterDb({
      ...CHAPTER,
      pastEvents: 3,
      pastCheckIns: 7,
      events: 6,
      liveEvents: 6,
      upcomingEvents: 3,
    });
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.events.averageAttendance).toBe(2.3);
  });

  /**
   * An event nobody turned up to still divides. Dropping it — an inner join to
   * the check-ins — raises the average of a chapter whose attendance is falling.
   */
  it("keeps an event nobody attended in the average's denominator", async () => {
    const { db, captures } = chapterDb({
      ...CHAPTER,
      pastEvents: 3,
      pastCheckIns: 1,
      events: 6,
      liveEvents: 6,
      upcomingEvents: 3,
    });
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.events.averageAttendance).toBe(0.3);

    const dropsEmptyEvents = pastScoped(captures)
      .filter((capture) =>
        capture.joins.some(
          (join) =>
            join.kind === "inner" && tableName(join.table) === CHECK_INS,
        ),
      )
      .map((capture) => sqlText(capture.where));
    expect(dropsEmptyEvents).toEqual([]);

    // The join alone is not enough: `count(*)` over a LEFT JOIN scores an
    // event nobody attended as one attendee, and the stub cannot see that.
    const numerators = pastScoped(captures)
      .filter((capture) =>
        capture.joins.some((join) => tableName(join.table) === CHECK_INS),
      )
      .flatMap((capture) => Object.values(capture.fields ?? {}).map(sqlText))
      .filter((text) => /count\s*\(/i.test(text) && !/distinct/i.test(text));
    expect(numerators.length).toBeGreaterThan(0);
    for (const text of numerators) {
      expect(text).not.toMatch(/count\s*\(\s*\*\s*\)/);
      expect(text).toMatch(new RegExp(`${CHECK_INS}\\.`, "i"));
    }
  });

  /**
   * One clock reading for the whole procedure. Reading it per query puts an
   * event that starts between two of them in both halves of the split, or in
   * neither, and dates the 30-day window from a different instant than the one
   * the split used.
   */
  it("splits past from upcoming and opens the 30-day window on one instant", async () => {
    const { db, captures } = chapterDb(CHAPTER);
    await underTickingClock(() =>
      createCaller(adminCtx(db)).chapter.overview(),
    );

    const bound = captures
      .flatMap((capture) => [
        ...Object.values(capture.fields ?? {}).flatMap(boundValues),
        ...boundValues(capture.where),
        ...boundValues(capture.having),
      ])
      .filter((value): value is Date => value instanceof Date);

    expect(bound.length).toBeGreaterThan(0);

    const instants = [...new Set(bound.map((date) => date.getTime()))];
    const split = Math.max(...instants);
    expect(instants).toContain(split - THIRTY_DAYS_MS);
    // Exactly two: the instant the split runs on, and that instant less 30
    // days. A third is a second reading of the clock.
    expect(instants).toHaveLength(2);
  });

  it("answers nextEvent with the soonest upcoming event, not the furthest", async () => {
    const { db, captures } = chapterDb(CHAPTER);
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.nextEvent?.id).toBe(SOONEST.id);
    expect(result.nextEvent?.title).toBe(SOONEST.title);
    expect(result.nextEvent?.startsAt).toEqual(SOONEST.startsAt);

    const rowQuery = captures.find(
      (capture) =>
        tableName(capture.from) === EVENTS &&
        capture.orderBy.map(orderText).join(", ").length > 0,
    );
    expect(rowQuery).toBeDefined();
    const order = rowQuery!.orderBy.map(orderText).join(", ");
    expect(order).toMatch(/starts.{0,3}at/i);
    // Descending here returns the event furthest away, which reads perfectly
    // plausibly on the dashboard and is never the next event.
    expect(order).not.toMatch(/\bdesc\b/i);

    // The future filter, asserted on the query rather than on the answer: the
    // fixture holds only upcoming events, so dropping the predicate entirely
    // returns the same rows here and last year's kickoff in production.
    expect(sqlText(rowQuery!.where)).toMatch(/starts.{0,3}at\s*>=?\s*\?/i);

    // The check-in code is a bearer credential; nothing member-adjacent may
    // carry it, and the contract's shape has no room for it.
    expect(Object.keys(result.nextEvent!).sort()).toEqual([
      "checkInEnabled",
      "currentCheckIns",
      "id",
      "location",
      "maxCheckIns",
      "startsAt",
      "title",
    ]);
  });

  it("answers nextEvent with null when nothing is upcoming", async () => {
    const { db } = chapterDb({ ...CHAPTER, upcomingEvents: 0, upcoming: [] });
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(result.nextEvent).toBeNull();
  });

  /**
   * Archiving is how an officer takes a cancelled or duplicated event off the
   * books. Counting one as a past event divides the attendance nobody was ever
   * going to earn into the average, and advertising one as the next event sends
   * members to a room that will be empty. `events.total` is live events only.
   */
  it("leaves archived events out of past, upcoming, the average and nextEvent", async () => {
    const { db, captures } = chapterDb(CHAPTER);
    const result = await createCaller(adminCtx(db)).chapter.overview();

    const fragments = captures.flatMap((capture) =>
      [...Object.values(capture.fields ?? {}), capture.where, capture.having]
        .filter((fragment) => fragment !== undefined && fragment !== null)
        .map(sqlText),
    );
    const liveScoped = fragments.filter((text) =>
      /archived.{0,3}at\s+is\s+null/i.test(text),
    );
    expect(liveScoped.length).toBeGreaterThan(0);

    expect(pastScoped(captures).length).toBeGreaterThan(0);

    expect(result.events.total).toBe(27);
    expect(result.events.past + result.events.upcoming).toBe(27);
  });

  /**
   * Counts come back through Drizzle's `count()` helper; the router coerces
   * driver strings with `asInt` so the dashboard always sees numbers.
   */
  it("returns numeric counts the dashboard can render", async () => {
    const { db } = chapterDb(CHAPTER);
    const result = await createCaller(adminCtx(db)).chapter.overview();

    expect(typeof result.members.total).toBe("number");
    expect(typeof result.checkIns.total).toBe("number");
    expect(typeof result.events.averageAttendance).toBe("number");
    expect(Number.isFinite(result.events.averageAttendance)).toBe(true);
  });

  /** Every member's attendance, and the chapter's own numbers. */
  it("is refused to a member who is not an officer", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).chapter.overview(),
    );

    expect(error.code).toBe("FORBIDDEN");
  });
});

const PAST_SERIES: EventRow[] = [
  {
    id: "event-12",
    title: "March GBM",
    startsAt: new Date("2026-03-12T22:30:00.000Z"),
    location: "Klaus 1443",
    checkInEnabled: true,
    currentCheckIns: 41,
    maxCheckIns: null,
    checkInCode: "SECRET12",
    archivedAt: null,
  },
  {
    id: "event-8",
    title: "Spring Kickoff",
    startsAt: new Date("2026-01-16T23:00:00.000Z"),
    location: "Klaus Atrium",
    checkInEnabled: true,
    currentCheckIns: 28,
    maxCheckIns: null,
    checkInCode: "SECRET08",
    archivedAt: null,
  },
];

describe("chapter.attendance", () => {
  it("is refused to a member who is not an officer", async () => {
    const error = await rejection(
      createCaller(memberCtx(unreachableDb)).chapter.attendance({
        period: "semester",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("returns countable past events newest-first without the check-in code", async () => {
    const { db, captures } = chapterDb({
      ...CHAPTER,
      series: PAST_SERIES,
    });
    const result = await createCaller(adminCtx(db)).chapter.attendance({
      period: "all",
    });

    expect(result.series.map((row) => row.id)).toEqual(["event-12", "event-8"]);
    expect(result.series.map((row) => row.checkIns)).toEqual([41, 28]);
    for (const row of result.series) {
      expect(Object.keys(row).sort()).toEqual([
        "checkIns",
        "id",
        "startsAt",
        "title",
      ]);
    }

    const seriesQuery = captures.find(
      (capture) =>
        tableName(capture.from) === EVENTS &&
        capture.groupBy.length > 0 &&
        capture.limit !== 1,
    );
    expect(seriesQuery).toBeDefined();
    expect(seriesQuery!.orderBy.map(orderText).join(", ")).toMatch(/\bdesc\b/i);
    expect(seriesQuery!.limit).toBe(48);
    expect(sqlText(seriesQuery!.where)).toMatch(/check.{0,3}in.{0,3}enabled/i);
  });

  it("opens a 30-day window on the same instant as the past cutoff", async () => {
    const { db, captures } = chapterDb({ ...CHAPTER, series: PAST_SERIES });
    await underTickingClock(() =>
      createCaller(adminCtx(db)).chapter.attendance({ period: "30d" }),
    );

    const bound = captures
      .flatMap((capture) => boundValues(capture.where))
      .filter((value): value is Date => value instanceof Date);
    const instants = [...new Set(bound.map((date) => date.getTime()))];
    const latest = Math.max(...instants);
    expect(instants).toContain(latest - THIRTY_DAYS_MS);
    expect(instants).toHaveLength(2);
  });

  it("starts the school year on 1 August in Atlanta", async () => {
    const { db } = chapterDb({ ...CHAPTER, series: PAST_SERIES });
    const result = await underTickingClock(() =>
      createCaller(adminCtx(db)).chapter.attendance({ period: "semester" }),
    );

    expect(result.since).toBeInstanceOf(Date);
    const atlanta = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(result.since!);
    expect(atlanta).toBe("2025-08-01");
  });

  it("does not bind a lower start date for all time", async () => {
    const { db, captures } = chapterDb({ ...CHAPTER, series: PAST_SERIES });
    const result = await createCaller(adminCtx(db)).chapter.attendance({
      period: "all",
    });

    expect(result.since).toBeNull();
    const lowerBounds = captures
      .map((capture) => sqlText(capture.where))
      .filter((text) => /starts.{0,3}at\s*>=?\s*\?/i.test(text));
    expect(lowerBounds).toEqual([]);
  });

  it("keeps empty events in the average's denominator", async () => {
    const { db, captures } = chapterDb({
      ...CHAPTER,
      pastEvents: 4,
      pastCheckIns: 2,
      series: PAST_SERIES,
    });
    const result = await createCaller(adminCtx(db)).chapter.attendance({
      period: "all",
    });

    expect(result.averageAttendance).toBe(0.5);

    const totals = captures.find(
      (capture) =>
        tableName(capture.from) === EVENTS &&
        capture.groupBy.length === 0 &&
        Object.keys(capture.fields ?? {}).includes("uniqueMembers"),
    );
    expect(totals).toBeDefined();
    expect(
      totals!.joins.some(
        (join) => join.kind === "left" && tableName(join.table) === CHECK_INS,
      ),
    ).toBe(true);
  });
});
