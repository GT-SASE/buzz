import { readFileSync } from "node:fs";

import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

/**
 * Production ran earlier drafts of 0009 and 0010, so it lacks two non-negative
 * checks, keeps `buzz_mentorship_enrollment.points` as bigint, and holds
 * negative points written outside the app. 0013 repairs the rows and puts the
 * schema back. It also has to be a no-op everywhere else: preview databases,
 * CI and local databases are built from 0000-0012 and already match.
 *
 * Each case builds its own database from the committed SQL, the way
 * `drizzle-kit migrate` would, and applies 0013 by hand. Nothing here touches
 * the database named by TEST_DATABASE_URL beyond creating and dropping the
 * scratch databases.
 */

const DRIFT_TAG = "0013_points_drift";

/**
 * `created_at` of the newest row in production's drizzle.__drizzle_migrations,
 * which is 0012's `when`. drizzle 0.x applies a migration only when its `when`
 * is later than the newest applied row, so a smaller one never runs there.
 */
const PRODUCTION_NEWEST_APPLIED = 1795299268188;

const migrationsDir = new URL("../packages/db/drizzle/", import.meta.url);

type JournalEntry = { idx: number; when: number; tag: string };

const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8"),
) as { entries: JournalEntry[] };

/** drizzle splits a migration file on this marker and runs each piece. */
function statementsOf(tag: string) {
  return readFileSync(new URL(`${tag}.sql`, migrationsDir), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe("0013_points_drift journal entry", () => {
  const entry = journal.entries.find(
    (candidate) => candidate.tag === DRIFT_TAG,
  );

  it("is registered after 0012", () => {
    expect(entry).toBeDefined();
    expect(entry!.idx).toBe(13);
    expect(journal.entries[journal.entries.length - 2]!.tag).toBe(
      "0012_rate_limit",
    );
  });

  it("has a `when` later than production's newest applied migration", () => {
    expect(entry!.when).toBeGreaterThan(PRODUCTION_NEWEST_APPLIED);
    for (const earlier of journal.entries.filter(
      (candidate) => candidate.idx < entry!.idx,
    )) {
      expect(entry!.when).toBeGreaterThan(earlier.when);
    }
  });
});

const adminUrl = process.env.DATABASE_URL;
const SLOW = 120_000;

type Scratch = { name: string; sql: SQL };

const scratchDatabases: Scratch[] = [];
let admin: SQL;

async function createScratch(): Promise<Scratch> {
  const name = `points_drift_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  const scratch = { name, sql: new SQL(url.toString(), { max: 1 }) };
  scratchDatabases.push(scratch);
  return scratch;
}

/** One transaction per migration, in journal order, like drizzle's migrator. */
async function applyThrough(sql: SQL, lastIdx: number) {
  for (const entry of journal.entries.filter((e) => e.idx <= lastIdx)) {
    await runMigration(sql, entry.tag);
  }
}

async function runMigration(sql: SQL, tag: string) {
  const statements = statementsOf(tag);
  await sql.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

/**
 * What production has: 0000-0012 applied, then the two checks gone and
 * mentorship points widened to bigint, plus rows only a client outside the app
 * could write. Values and shapes are the ones found in production.
 */
async function makeProductionShaped(sql: SQL) {
  await sql.unsafe(`
    ALTER TABLE "buzz_event_check_in" DROP CONSTRAINT "buzz_check_in_points_earned_check";
    ALTER TABLE "buzz_mentorship_enrollment" DROP CONSTRAINT "buzz_mentorship_points_check";
    ALTER TABLE "buzz_mentorship_enrollment" ALTER COLUMN "points" SET DATA TYPE bigint;
  `);
  await seed(sql, {
    checkIns: [
      // negative code check-ins at 15 and 20 point events
      ["c-min", "e-15-a", "u-1", "code", -2147483648],
      ["c-985", "e-15-a", "u-2", "code", -985],
      ["c-30", "e-20", "u-3", "code", -30],
      // rows that are already fine stay exactly as they are
      ["c-ok", "e-15-b", "u-1", "code", 15],
      ["c-zero", "e-15-b", "u-2", "code", 0],
      ["c-manual", "e-20", "u-4", "manual", 7],
    ],
    mentorships: [
      ["u-1", "2026-2027", "mentee", "interested", -67],
      ["u-2", "2026-2027", "mentee", "interested", -2147483648],
      ["u-3", "2026-2027", "mentor", "enrolled", 12],
      ["u-4", "2026-2027", "mentee", "interested", 0],
    ],
  });
}

/** Rows a database built from 0000-0012 can hold. */
async function makeCleanData(sql: SQL) {
  await seed(sql, {
    checkIns: [
      ["c-1", "e-15-a", "u-1", "code", 15],
      ["c-2", "e-20", "u-2", "code", 20],
      ["c-3", "e-20", "u-3", "manual", 7],
      ["c-4", "e-15-b", "u-1", "code", 0],
    ],
    mentorships: [
      ["u-1", "2026-2027", "mentee", "interested", 0],
      ["u-2", "2026-2027", "mentor", "enrolled", 25],
    ],
  });
}

async function seed(
  sql: SQL,
  rows: {
    checkIns: [string, string, string, string, number][];
    mentorships: [string, string, string, string, number][];
  },
) {
  const users = ["u-1", "u-2", "u-3", "u-4"];
  const events: [string, number][] = [
    ["e-15-a", 15],
    ["e-15-b", 15],
    ["e-20", 20],
  ];
  await sql.begin(async (tx) => {
    for (const id of users) {
      await tx.unsafe(
        `INSERT INTO "buzz_user" (id, email) VALUES ('${id}', '${id}@example.test')`,
      );
    }
    for (const [id, pointsValue] of events) {
      await tx.unsafe(
        `INSERT INTO "buzz_event" (id, title, "startsAt", "pointsValue", "checkInCode", "createdById", "createdAt")
         VALUES ('${id}', 'Event ${id}', now(), ${pointsValue}, '${id}', 'u-1', now())`,
      );
    }
    for (const [id, eventId, userId, method, points] of rows.checkIns) {
      await tx.unsafe(
        `INSERT INTO "buzz_event_check_in" (id, "eventId", "userId", method, "pointsEarned", "checkedInAt")
         VALUES ('${id}', '${eventId}', '${userId}', '${method}', ${points}, now())`,
      );
    }
    for (const [userId, year, role, status, points] of rows.mentorships) {
      await tx.unsafe(
        `INSERT INTO "buzz_mentorship_enrollment" ("userId", year, role, status, points, "createdAt")
         VALUES ('${userId}', '${year}', '${role}', '${status}', ${points}, now())`,
      );
    }
  });
}

/**
 * The public schema as a sorted list of lines: columns, constraints (with
 * whether they are validated) and indexes. Sorted by name, so column order,
 * which differs between a patched database and a fresh one, does not count.
 */
async function schemaOf(sql: SQL) {
  const columns = await sql.unsafe<
    {
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }[]
  >(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name
  `);
  const constraints = await sql.unsafe<
    { relation: string; name: string; validated: boolean; definition: string }[]
  >(`
    SELECT conrelid::regclass::text AS relation, conname AS name,
           convalidated AS validated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
    ORDER BY 1, 2
  `);
  const indexes = await sql.unsafe<{ name: string; definition: string }[]>(`
    SELECT indexname AS name, indexdef AS definition
    FROM pg_indexes
    WHERE schemaname = 'public'
    ORDER BY indexname
  `);
  return {
    columns: columns.map((c) => ({ ...c })),
    constraints: constraints.map((c) => ({ ...c })),
    indexes: indexes.map((i) => ({ ...i })),
  };
}

async function rowsOf(sql: SQL) {
  const checkIns = await sql.unsafe<
    { id: string; eventId: string; method: string; pointsEarned: number }[]
  >(
    `SELECT id, "eventId", method, "pointsEarned" FROM "buzz_event_check_in" ORDER BY id COLLATE "C"`,
  );
  const mentorships = await sql.unsafe<
    {
      userId: string;
      year: string;
      role: string;
      status: string;
      points: string;
    }[]
  >(
    `SELECT "userId", year, role, status, points::text AS points FROM "buzz_mentorship_enrollment" ORDER BY "userId" COLLATE "C", year`,
  );
  return {
    checkIns: checkIns.map((row) => ({ ...row })),
    mentorships: mentorships.map((row) => ({ ...row })),
  };
}

/** Constraint names on one table, and its `points` column type. */
async function pointsShape(sql: SQL) {
  const [column] = await sql.unsafe<{ data_type: string }[]>(`
    SELECT data_type FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'buzz_mentorship_enrollment'
      AND column_name = 'points'
  `);
  const checks = await sql.unsafe<{ name: string; validated: boolean }[]>(`
    SELECT conname AS name, convalidated AS validated FROM pg_constraint
    WHERE contype = 'c'
      AND conname IN ('buzz_check_in_points_earned_check', 'buzz_mentorship_points_check')
    ORDER BY conname
  `);
  return {
    mentorshipPointsType: column!.data_type,
    checks: checks.map((check) => ({ ...check })),
  };
}

describe.skipIf(!adminUrl)("0013_points_drift on Postgres", () => {
  let fresh: Scratch;
  let freshSchema: Awaited<ReturnType<typeof schemaOf>>;

  beforeAll(async () => {
    admin = new SQL(adminUrl!, { max: 1 });
    fresh = await createScratch();
    await applyThrough(fresh.sql, 12);
    freshSchema = await schemaOf(fresh.sql);
  }, SLOW);

  afterAll(async () => {
    for (const scratch of scratchDatabases) {
      await scratch.sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${scratch.name}"`);
    }
    await admin.close();
  }, SLOW);

  it(
    "repairs a production-shaped database and restores the schema",
    async () => {
      const { sql } = await createScratch();
      await applyThrough(sql, 12);
      await makeProductionShaped(sql);

      // The harness really reproduces production's drift.
      expect(await pointsShape(sql)).toEqual({
        mentorshipPointsType: "bigint",
        checks: [],
      });
      expect(await schemaOf(sql)).not.toEqual(freshSchema);

      await runMigration(sql, DRIFT_TAG);

      expect(await rowsOf(sql)).toEqual({
        checkIns: [
          // each negative becomes its own event's pointsValue
          { id: "c-30", eventId: "e-20", method: "code", pointsEarned: 20 },
          { id: "c-985", eventId: "e-15-a", method: "code", pointsEarned: 15 },
          {
            id: "c-manual",
            eventId: "e-20",
            method: "manual",
            pointsEarned: 7,
          },
          { id: "c-min", eventId: "e-15-a", method: "code", pointsEarned: 15 },
          { id: "c-ok", eventId: "e-15-b", method: "code", pointsEarned: 15 },
          { id: "c-zero", eventId: "e-15-b", method: "code", pointsEarned: 0 },
        ],
        mentorships: [
          {
            userId: "u-1",
            year: "2026-2027",
            role: "mentee",
            status: "interested",
            points: "0",
          },
          {
            userId: "u-2",
            year: "2026-2027",
            role: "mentee",
            status: "interested",
            points: "0",
          },
          {
            userId: "u-3",
            year: "2026-2027",
            role: "mentor",
            status: "enrolled",
            points: "12",
          },
          {
            userId: "u-4",
            year: "2026-2027",
            role: "mentee",
            status: "interested",
            points: "0",
          },
        ],
      });

      expect(await pointsShape(sql)).toEqual({
        mentorshipPointsType: "integer",
        checks: [
          { name: "buzz_check_in_points_earned_check", validated: true },
          { name: "buzz_mentorship_points_check", validated: true },
        ],
      });
      expect(await schemaOf(sql)).toEqual(freshSchema);

      // Both checks now refuse a negative value.
      await expect(
        (async () => {
          await sql.unsafe(
            `INSERT INTO "buzz_event_check_in" (id, "eventId", "userId", method, "pointsEarned", "checkedInAt")
             VALUES ('c-neg', 'e-20', 'u-1', 'code', -1, now())`,
          );
        })(),
      ).rejects.toThrow("buzz_check_in_points_earned_check");
      await expect(
        (async () => {
          await sql.unsafe(
            `UPDATE "buzz_mentorship_enrollment" SET points = -1 WHERE "userId" = 'u-3'`,
          );
        })(),
      ).rejects.toThrow("buzz_mentorship_points_check");

      // A second run finds nothing left to do.
      const rows = await rowsOf(sql);
      await runMigration(sql, DRIFT_TAG);
      expect(await rowsOf(sql)).toEqual(rows);
      expect(await schemaOf(sql)).toEqual(freshSchema);
    },
    SLOW,
  );

  it(
    "changes nothing on a database built from 0000-0012",
    async () => {
      const { sql } = await createScratch();
      await applyThrough(sql, 12);
      await makeCleanData(sql);
      const schemaBefore = await schemaOf(sql);
      const rowsBefore = await rowsOf(sql);
      expect(schemaBefore).toEqual(freshSchema);

      await runMigration(sql, DRIFT_TAG);

      expect(await schemaOf(sql)).toEqual(schemaBefore);
      expect(await rowsOf(sql)).toEqual(rowsBefore);
    },
    SLOW,
  );
});
