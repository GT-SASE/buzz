/**
 * The bot's migrations applied to a database that already holds data. Production had
 * 0000 and 0001 when 0002 came, with history rows in `row_versions`, some of them from a
 * row that returned to an earlier state. 0002 adds the column and the index the bot uses
 * to find a version a trigger already kept in its transaction; it must leave the old
 * history as it was, and the database it leaves must be the one a fresh server gets.
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  NO_TRIGGERS,
  createMigratedDb,
  migrateWithDrizzle,
  newServer,
} from "./harness.ts";

/** Every fact about discord_bot the schema and its grants state, as plain rows. */
const SNAPSHOT = `
  SELECT 'column' AS kind,
         format('%s.%s', c.relname, a.attname) AS name,
         format('%s | pos %s | notnull %s | default %s | identity %s | generated %s',
                format_type(a.atttypid, a.atttypmod), a.attnum, a.attnotnull,
                coalesce(pg_get_expr(d.adbin, d.adrelid), ''), a.attidentity, a.attgenerated) AS detail
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relkind = 'r'
     AND a.attnum > 0 AND NOT a.attisdropped
     AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'constraint', format('%s.%s', c.relname, k.conname), pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'index', i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typnamespace = 'discord_bot'::regnamespace GROUP BY t.typname
  UNION ALL
  SELECT 'trigger', format('%s.%s', c.relname, g.tgname), pg_get_triggerdef(g.oid)
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND NOT g.tgisinternal
  UNION ALL
  SELECT 'function', p.proname, format('%s | secdef %s | acl %s',
         pg_get_functiondef(p.oid), p.prosecdef, coalesce(p.proacl::text, ''))
    FROM pg_proc p WHERE p.pronamespace = 'discord_bot'::regnamespace
  UNION ALL
  SELECT 'table acl', c.relname, coalesce(c.relacl::text, '')
    FROM pg_class c
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relkind IN ('r', 'S')
     AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'column acl', format('%s.%s', c.relname, a.attname), a.attacl::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND a.attacl IS NOT NULL
     AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'rls', c.relname, format('enabled %s | forced %s', c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relkind = 'r'
     AND c.relname <> 'drizzle_migrations'
  UNION ALL
  SELECT 'policy', format('%s.%s', tablename, policyname),
         format('%s | %s | %s | %s', cmd, roles, coalesce(qual, ''), coalesce(with_check, ''))
    FROM pg_policies WHERE schemaname = 'discord_bot'
  ORDER BY 1, 2, 3`;

const snapshot = async (db: PGlite): Promise<unknown[]> =>
  (await db.query(SNAPSHOT)).rows;

/** Two journal entries, 0000 and 0001: what production held before this change. */
function olderMigrations(): string {
  const folder = mkdtempSync(join(tmpdir(), "bot-migrations-"));
  cpSync(MIGRATIONS_DIR, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: unknown[];
  };
  journal.entries = journal.entries.slice(0, 2);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

let fresh: PGlite;
let stepped: PGlite;

beforeAll(async () => {
  fresh = await createMigratedDb();
  stepped = await newServer();
  await migrateWithDrizzle(stepped, olderMigrations());
  // History from before 0002, as the trigger wrote it: a row that went back to an
  // earlier state leaves the same old row twice, in different transactions.
  await stepped.exec(`
    INSERT INTO discord_bot.row_versions (source_table, operation, row_id, old_row, changed_at)
    VALUES
      ('tasks', 'UPDATE', 'a', '{"state": 1}', '2030-01-01'),
      ('tasks', 'UPDATE', 'a', '{"state": 1}', '2030-02-01'),
      ('tasks', 'UPDATE', 'a', '{"state": 2}', '2030-03-01'),
      ('tasks', 'UPDATE', 'a', '{"state": 1}', '2030-04-01')
  `);
  await migrateWithDrizzle(stepped);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await fresh.close();
  await stepped.close();
});

describe("0002 on a database that holds history", () => {
  it("keeps every old history row, none of them stamped with the migration's transaction", async () => {
    const { rows } = await stepped.query<{ n: number; unstamped: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE xid IS NULL)::int AS unstamped
       FROM discord_bot.row_versions`,
    );
    expect(rows).toEqual([{ n: 4, unstamped: 4 }]);
  });

  it("stamps a new row with its transaction", async () => {
    await stepped.exec(`
      BEGIN;
      INSERT INTO discord_bot.row_versions (source_table, operation, row_id, old_row)
        VALUES ('tasks', 'UPDATE', 'b', '{"state": 1}');
      COMMIT;
    `);
    const { rows } = await stepped.query<{ n: number; stamped: number }>(
      `SELECT count(*)::int AS n, count(xid)::int AS stamped
       FROM discord_bot.row_versions WHERE row_id = 'b'`,
    );
    expect(rows).toEqual([{ n: 1, stamped: 1 }]);
  });

  it("lets a row come back to an earlier state in a later transaction", async () => {
    for (const state of [1, 2, 1]) {
      await stepped.query(
        `INSERT INTO discord_bot.row_versions (source_table, operation, row_id, old_row)
         VALUES ('tasks', 'UPDATE', 'c', $1::jsonb)`,
        [JSON.stringify({ state })],
      );
    }
    const { rows } = await stepped.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM discord_bot.row_versions WHERE row_id = 'c'",
    );
    expect(rows[0]?.n).toBe(3);
  });
});

describe.skipIf(NO_TRIGGERS)("a database migrated in two steps", () => {
  it("is the database a fresh server gets: columns, keys, indexes, triggers, grants and policies", async () => {
    const left = await snapshot(stepped);
    expect(left.length).toBeGreaterThan(300);
    expect(left).toEqual(await snapshot(fresh));
  });

  it("ledgers each migration once, as a fresh one does", async () => {
    const ledger = (db: PGlite) =>
      db.query<{ hash: string }>(
        "SELECT hash FROM discord_bot.drizzle_migrations ORDER BY created_at",
      );
    expect((await ledger(stepped)).rows).toEqual((await ledger(fresh)).rows);
  });

  it("is not changed by running the migrations again", async () => {
    const before = await snapshot(stepped);
    await migrateWithDrizzle(stepped);
    expect(await snapshot(stepped)).toEqual(before);
  });
});
