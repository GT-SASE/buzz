import { readFileSync } from "node:fs";

import { describe, expect, it, mock } from "bun:test";

/**
 * The ledger migration copies numbers; it must not move a single total. This
 * builds the schema as it stood before the ledger in a scratch schema inside
 * one transaction, seeds members, check-ins (some on an archived event, some
 * stamped by an officer, some from before an event was re-priced) and KIN
 * points, reads every total the way the screens do, applies the ledger
 * migration, reads them again, and checks that they are identical and that the
 * ledger sums to them. The transaction is rolled back, so nothing is left in
 * the database and nothing here can reach a real table.
 */
mock.module("../packages/auth/src/index.ts", () => ({
  auth: () => Promise.resolve(null),
  handlers: {},
  signIn: () => Promise.resolve(undefined),
  signOut: () => Promise.resolve(undefined),
}));

const { db } = await import("../packages/db/src/index");
const { createCaller } = await import("../packages/api/src/root");
const { sql } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const MIGRATIONS = new URL("../packages/db/drizzle/", import.meta.url);
const LEDGER_MIGRATION = "0014_audit_log_points_ledger";

class Rollback extends Error {}

function statementsOf(tag: string) {
  return (
    readFileSync(new URL(`${tag}.sql`, MIGRATIONS), "utf8")
      // The FKs and 0009's catalog lookup name `public`; the scratch schema
      // has to resolve to itself, or they would read the real tables.
      .replaceAll('"public".', "")
      .replaceAll("nsp.nspname = 'public'", "nsp.nspname = current_schema()")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean)
  );
}

const journal = JSON.parse(
  readFileSync(new URL("meta/_journal.json", MIGRATIONS), "utf8"),
) as { entries: { tag: string }[] };

const before = journal.entries
  .map((entry) => entry.tag)
  .filter((tag) => tag < LEDGER_MIGRATION);

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

describe.skipIf(!process.env.DATABASE_URL)("points ledger backfill", () => {
  it("leaves every total as it was and makes the ledger sum to it", async () => {
    const scratch = `ledger_backfill_${crypto.randomUUID().replaceAll("-", "")}`;

    const run = (tx: Tx, text: string) => tx.execute(sql.raw(text));

    await db
      .transaction(async (tx) => {
        await run(tx, `CREATE SCHEMA "${scratch}"`);
        await run(tx, `SET LOCAL search_path TO "${scratch}"`);
        for (const tag of before) {
          for (const statement of statementsOf(tag)) {
            await run(tx, statement);
          }
        }

        // ------------------------------------------------------- seed
        // The app stamps these timestamps in code, so the tables have no SQL
        // default; the seed below writes plain SQL and needs one.
        for (const [table, column] of [
          ["buzz_event", "createdAt"],
          ["buzz_mentorship_enrollment", "createdAt"],
          ["buzz_kin_group", "createdAt"],
          ["buzz_kin_membership", "joinedAt"],
        ] as const) {
          await run(
            tx,
            `ALTER TABLE ${table} ALTER COLUMN "${column}" SET DEFAULT now()`,
          );
        }
        // Production had check-ins and signups with negative points (as low as
        // INT_MIN) because it lacked the `>= 0` checks the schema declares;
        // 0013_points_drift repaired them and restored the checks. The ledger
        // migration must still copy such rows as they are, whatever state a
        // database is in, so the scratch schema drops the checks again.
        // Dropped by definition, not by name.
        await run(
          tx,
          `DO $$
            DECLARE c record;
            BEGIN
              FOR c IN
                SELECT conrelid::regclass::text AS tbl, conname
                  FROM pg_constraint
                 WHERE contype = 'c'
                   AND connamespace = current_schema()::regnamespace
                   AND conrelid::regclass::text IN ('buzz_event_check_in', 'buzz_mentorship_enrollment')
                   AND pg_get_constraintdef(oid) LIKE '%oints%'
              LOOP
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
              END LOOP;
            END $$`,
        );
        const members = ["ada", "bo", "cy", "dee", "eli", "fay", "gus"];
        await run(
          tx,
          `INSERT INTO buzz_user (id, email, name, role) VALUES
              ${members.map((m) => `('${m}', '${m}@gatech.edu', '${m}', 'MEMBER')`).join(", ")},
              ('boss', 'boss@gatech.edu', 'boss', 'ADMIN')`,
        );
        await run(
          tx,
          `INSERT INTO buzz_event (id, title, "startsAt", "pointsValue", "checkInCode", "createdById", "archivedAt") VALUES
              ('ev-a', 'GBM 1', '2026-09-01T18:00Z', 12, 'CODEAAAA', 'boss', NULL),
              ('ev-b', 'Workshop', '2026-09-08T18:00Z', 5, 'CODEBBBB', 'boss', NULL),
              ('ev-c', 'Social', '2026-09-15T18:00Z', 0, 'CODECCCC', 'boss', NULL),
              ('ev-d', 'Old retreat', '2026-01-20T18:00Z', 20, 'CODEDDDD', 'boss', '2026-02-01T00:00Z')`,
        );
        // ev-a was re-priced to 12 after the first scans, so its check-ins
        // carry 10 and the ledger has to copy that, not the event's 12.
        await run(
          tx,
          `INSERT INTO buzz_event_check_in (id, "eventId", "userId", method, "pointsEarned", "actedByUserId", "checkedInAt") VALUES
              ('ci-1', 'ev-a', 'ada', 'code', 10, NULL, '2026-09-01T18:05Z'),
              ('ci-2', 'ev-a', 'bo', 'code', 10, NULL, '2026-09-01T18:07Z'),
              ('ci-3', 'ev-a', 'cy', 'manual', 12, 'boss', '2026-09-01T19:00Z'),
              ('ci-4', 'ev-b', 'ada', 'code', 5, NULL, '2026-09-08T18:02Z'),
              ('ci-5', 'ev-b', 'cy', 'code', 5, NULL, '2026-09-08T18:03Z'),
              ('ci-6', 'ev-c', 'ada', 'code', 0, NULL, '2026-09-15T18:01Z'),
              ('ci-7', 'ev-d', 'ada', 'code', 20, NULL, '2026-01-20T18:10Z'),
              ('ci-8', 'ev-d', 'dee', 'manual', 20, 'boss', '2026-01-20T18:20Z'),
              ('ci-9', 'ev-a', 'gus', 'code', -2147483648, NULL, '2026-09-01T18:09Z'),
              ('ci-10', 'ev-b', 'gus', 'manual', -2147483648, 'boss', '2026-09-08T18:10Z')`,
        );
        await run(
          tx,
          `INSERT INTO buzz_mentorship_enrollment ("userId", year, role, status, points, "updatedAt") VALUES
              ('ada', '2026-2027', 'mentor', 'enrolled', 15, '2026-10-02T12:00Z'),
              ('bo', '2026-2027', 'mentee', 'enrolled', 8, '2026-10-05T12:00Z'),
              ('bo', '2025-2026', 'mentee', 'enrolled', 20, '2026-04-01T12:00Z'),
              ('cy', '2026-2027', 'mentee', 'interested', 0, NULL),
              ('dee', '2026-2027', 'mentee', 'withdrawn', 3, NULL),
              ('eli', '2026-2027', 'mentee', 'enrolled', -2147483648, NULL),
              ('fay', '2025-2026', 'mentee', 'enrolled', -3, NULL)`,
        );
        // A group seat's points are part of the enrollment total, not extra.
        await run(
          tx,
          `INSERT INTO buzz_kin_group (id, year, semester, name) VALUES
              ('kg-1', '2026-2027', 'fall-2026', 'Hive')`,
        );
        await run(
          tx,
          `INSERT INTO buzz_kin_membership ("userId", semester, "groupId", points) VALUES
              ('ada', 'fall-2026', 'kg-1', 9),
              ('bo', 'fall-2026', 'kg-1', 4)`,
        );

        // -------------------------------------------------- the reads
        const caller = createCaller({
          db: tx as never,
          session: {
            user: { id: "boss", role: "ADMIN", email: "boss@gatech.edu" },
            expires: "2099-01-01T00:00:00.000Z",
          },
          headers: new Headers(),
        });

        const totals = async () => {
          const roster = await caller.member.list({ limit: 100 });
          const events = new Map(
            roster.members.map((m) => [
              m.id,
              { points: m.totalPoints, events: m.totalEvents },
            ]),
          );
          const kin = new Map<string, number>();
          for (const term of ["fall-2025", "fall-2026"]) {
            for (const row of await caller.mentorship.list({
              semester: term,
            })) {
              kin.set(row.userId, (kin.get(row.userId) ?? 0) + row.points);
            }
          }
          return { events, kin };
        };

        const readLedger = async () => {
          const rows =
            // bigint, not int: two INT_MIN rows sum past the int range. The
            // driver returns bigint as a string.
            (
              await run(
                tx,
                `SELECT l."userId" AS id,
                  COALESCE(SUM(l.delta) FILTER (
                    WHERE l.source IN ('check_in', 'manual_check_in', 'check_in_removed')
                      AND e."archivedAt" IS NULL
                  ), 0)::bigint AS event_points,
                  COALESCE(SUM(l.delta) FILTER (
                    WHERE l.source IN ('kin_award', 'kin_group_award', 'opening_balance')
                  ), 0)::bigint AS kin_points
                FROM buzz_points_ledger l
                LEFT JOIN buzz_event e ON e.id = l."eventId"
                GROUP BY l."userId"`,
              )
            ).rows as {
              id: string;
              event_points: string;
              kin_points: string;
            }[];
          return new Map(
            rows.map((row) => [
              row.id,
              {
                event_points: Number(row.event_points),
                kin_points: Number(row.kin_points),
              },
            ]),
          );
        };

        const first = await totals();
        // Sanity on the seed: it covers what the migration must preserve.
        expect(first.events.get("ada")).toMatchObject({ points: 15 });
        expect(first.events.get("dee")).toMatchObject({ points: 0 });
        expect(first.kin.get("bo")).toBe(28);
        // Negatives as production has them: two INT_MIN check-ins on one
        // member sum below the int range; a signup sits at INT_MIN too.
        expect(first.events.get("gus")).toMatchObject({ points: -4294967296 });
        expect(first.kin.get("eli")).toBe(-2147483648);
        expect(first.kin.get("fay")).toBe(-3);

        // ---------------------------------------------- the migration
        for (const statement of statementsOf(LEDGER_MIGRATION)) {
          await run(tx, statement);
        }

        // The board also reads the opt-out table, which 0016 adds.
        for (const statement of statementsOf("0016_leaderboard_preferences")) {
          await run(tx, statement);
        }

        const second = await totals();
        expect(second.events).toEqual(first.events);
        expect(second.kin).toEqual(first.kin);
        // The board reads the ledger, so it can only be read once the
        // migration has made one. Everyone on it carries the total the
        // roster showed before.
        const board = await caller.member.leaderboard({ limit: 50 });
        expect(board.top.length).toBeGreaterThan(0);
        const names = new Map(
          (await caller.member.list({ limit: 100 })).members.map((m) => [
            m.name,
            m.id,
          ]),
        );
        for (const row of board.top) {
          const id = names.get(row.name);
          expect(id).toBeDefined();
          expect(row.totalPoints).toBe(first.events.get(id!)?.points ?? 0);
        }

        // ----------------------------- the ledger agrees with them
        const ledger = await readLedger();
        for (const id of [...members, "boss"]) {
          expect(ledger.get(id)?.event_points ?? 0).toBe(
            first.events.get(id)?.points ?? 0,
          );
          expect(ledger.get(id)?.kin_points ?? 0).toBe(first.kin.get(id) ?? 0);
        }

        // One row per check-in, with the check-in's own time, snapshot,
        // method and officer; one opening balance per non-zero KIN total.
        const counts = (
          await run(
            tx,
            `SELECT
                (SELECT count(*) FROM buzz_event_check_in)::int AS check_ins,
                (SELECT count(*) FROM buzz_points_ledger WHERE source IN ('check_in', 'manual_check_in'))::int AS grants,
                (SELECT count(*) FROM buzz_mentorship_enrollment WHERE points <> 0)::int AS balances,
                (SELECT count(*) FROM buzz_points_ledger WHERE source = 'opening_balance')::int AS openings,
                (SELECT count(*) FROM buzz_points_ledger)::int AS everything`,
          )
        ).rows[0] as Record<string, number>;
        expect(counts).toEqual({
          check_ins: 10,
          grants: 10,
          balances: 6,
          openings: 6,
          everything: 16,
        });

        // Copied as they are, not clamped, skipped or failed on.
        const negatives = (
          await run(
            tx,
            `SELECT "userId", source, delta FROM buzz_points_ledger
              WHERE delta < 0 ORDER BY "userId", source`,
          )
        ).rows;
        expect(negatives).toEqual([
          { userId: "eli", source: "opening_balance", delta: -2147483648 },
          { userId: "fay", source: "opening_balance", delta: -3 },
          { userId: "gus", source: "check_in", delta: -2147483648 },
          { userId: "gus", source: "manual_check_in", delta: -2147483648 },
        ]);

        const manual = (
          await run(
            tx,
            `SELECT delta, "actedByUserId", "eventId", at, reason
               FROM buzz_points_ledger l WHERE "userId" = 'cy' AND source = 'manual_check_in'`,
          )
        ).rows[0]!;
        expect(manual).toMatchObject({
          delta: 12,
          actedByUserId: "boss",
          eventId: "ev-a",
          reason: "Checked in by an officer: GBM 1",
        });
        expect(new Date(manual.at as string).toISOString()).toBe(
          "2026-09-01T19:00:00.000Z",
        );

        // ev-a was re-priced to 12, but the snapshot on the check-in is 10.
        const snapshot = (
          await run(
            tx,
            `SELECT delta FROM buzz_points_ledger WHERE "userId" = 'ada' AND "eventId" = 'ev-a'`,
          )
        ).rows[0] as { delta: number };
        expect(snapshot.delta).toBe(10);

        throw new Rollback();
      })
      .catch((error: unknown) => {
        // The rollback is the pass; anything else is the failure to report.
        if (!(error instanceof Rollback)) throw error;
      });
  }, 60_000);
});
