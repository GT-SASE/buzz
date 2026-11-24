/**
 * The switch from dbmate to Drizzle. A production database holds dbmate's six files and no
 * Drizzle ledger, and has to come out of `bun run db:migrate` as the database a new one is,
 * with 0000_baseline.sql never run against it. The test builds both, as the owner, and
 * compares everything the schema says: columns, keys, checks, indexes, enums, the domain,
 * triggers, the functions that stay, and every grant. The functions dbmate made for the
 * old bot code are the one difference, as they stay until a later change drops them.
 */

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { DBMATE_VERSIONS, adoptDbmateDatabase } from "../../db/migrate.ts";
import {
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  MIGRATION_OWNER,
  createLegacyDb,
  createMigratedDb,
} from "./harness.ts";

/** What dbmate's files made for the old bot code. */
const LEGACY_FUNCTIONS = [
  "apply_config_change",
  "apply_role_bindings",
  "assign_event_step",
  "begin_job_run",
  "claim_event_post_attempt",
  "claim_event_reminder",
  "claim_interaction",
  "claim_reminder",
  "claim_step_handoff",
  "close_stale_event_reminder",
  "close_stale_reminder",
  "complete_event_step",
  "edit_task",
  "event_reminder_allowed",
  "event_reminder_day_open",
  "expire_interaction_claims",
  "finish_job_run",
  "mark_channel_unavailable",
  "mark_event_reminder_sent",
  "mark_event_reminder_skipped",
  "mark_reminder_sent",
  "mark_reminder_skipped",
  "mark_step_handoff_sent",
  "reclaim_event_reminder",
  "reclaim_reminder",
  "record_reminder_refused",
  "release_event_post_attempt",
  "reopen_event_step",
  "save_setup_draft",
  "set_event_pickup_time",
  "set_slides_not_needed",
  "soft_delete_event",
  "sync_food_pickup_step",
  "unassign_event_step",
];

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
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'constraint', format('%s.%s', c.relname, k.conname), pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'index', i.indexrelid::regclass::text, pg_get_indexdef(i.indexrelid)
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'enum', t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE t.typnamespace = 'discord_bot'::regnamespace GROUP BY t.typname
  UNION ALL
  SELECT 'domain', t.typname,
         format_type(t.typbasetype, t.typtypmod) || ' | ' ||
         coalesce((SELECT string_agg(pg_get_constraintdef(k.oid), ',') FROM pg_constraint k WHERE k.contypid = t.oid), '')
    FROM pg_type t WHERE t.typnamespace = 'discord_bot'::regnamespace AND t.typtype = 'd'
  UNION ALL
  SELECT 'trigger', format('%s.%s', c.relname, g.tgname), pg_get_triggerdef(g.oid)
    FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND NOT g.tgisinternal
  UNION ALL
  SELECT 'function', p.proname, format('%s | secdef %s | config %s | acl %s',
         pg_get_functiondef(p.oid), p.prosecdef, coalesce(p.proconfig::text, ''), coalesce(p.proacl::text, ''))
    FROM pg_proc p
   WHERE p.pronamespace = 'discord_bot'::regnamespace AND NOT (p.proname = ANY ($1))
  UNION ALL
  SELECT 'table acl', c.relname, coalesce(c.relacl::text, '')
    FROM pg_class c
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relkind IN ('r', 'S')
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'column acl', format('%s.%s', c.relname, a.attname), a.attacl::text
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND a.attacl IS NOT NULL
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'type acl', t.typname, coalesce(t.typacl::text, '')
    FROM pg_type t WHERE t.typnamespace = 'discord_bot'::regnamespace AND t.typtype IN ('e', 'd')
  UNION ALL
  SELECT 'schema acl', nspname, coalesce(nspacl::text, '')
    FROM pg_namespace WHERE nspname = 'discord_bot'
  UNION ALL
  SELECT 'rls', c.relname, format('enabled %s | forced %s', c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c
   WHERE c.relnamespace = 'discord_bot'::regnamespace AND c.relkind = 'r'
     AND c.relname NOT IN ('schema_migrations', 'drizzle_migrations')
  UNION ALL
  SELECT 'policy', format('%s.%s', tablename, policyname),
         format('%s | %s | %s | %s', cmd, roles, coalesce(qual, ''), coalesce(with_check, ''))
    FROM pg_policies WHERE schemaname = 'discord_bot'
  UNION ALL
  SELECT 'role', rolname,
         format('login %s | super %s | createrole %s | inherit %s | settings %s', rolcanlogin, rolsuper, rolcreaterole, rolinherit,
                coalesce((SELECT array_agg(s ORDER BY s)::text FROM pg_db_role_setting, unnest(setconfig) s WHERE setrole = r.oid), ''))
    FROM pg_roles r WHERE rolname = 'bot_app'
  ORDER BY 1, 2, 3`;

async function snapshot(db: PGlite): Promise<unknown[]> {
  return (await db.query(SNAPSHOT, [LEGACY_FUNCTIONS])).rows;
}

async function ledger(db: PGlite): Promise<unknown[]> {
  return (
    await db.query(
      "SELECT hash, created_at::text AS created_at FROM discord_bot.drizzle_migrations ORDER BY created_at",
    )
  ).rows;
}

/** Adopts a dbmate database, then migrates it, as the owner, as `bun run db:migrate` does. */
async function migrateAsOwner(db: PGlite): Promise<string> {
  await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
  try {
    const adoption = await adoptDbmateDatabase(db);
    await migrate(drizzle(db), {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsSchema: "discord_bot",
      migrationsTable: "drizzle_migrations",
    });
    return adoption;
  } finally {
    await db.exec("RESET ROLE");
  }
}

let fresh: PGlite;
let adopted: PGlite;
let adoption: string;

beforeAll(async () => {
  fresh = await createMigratedDb();
  adopted = await createLegacyDb();
  adoption = await migrateAsOwner(adopted);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await fresh.close();
  await adopted.close();
});

describe("a database dbmate built", () => {
  it("is adopted: the baseline is marked applied, not run", () => {
    expect(adoption).toBe("adopted");
  });

  it("holds the six dbmate versions the baseline stands for", async () => {
    const { rows } = await adopted.query<{ version: string }>(
      "SELECT version FROM discord_bot.schema_migrations ORDER BY version",
    );
    expect(rows.map((row) => row.version)).toEqual([...DBMATE_VERSIONS]);
  });

  it("ledgers the same two migrations, by hash and time, as a new database", async () => {
    const [baseline] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
    expect(await ledger(adopted)).toEqual(await ledger(fresh));
    expect((await ledger(adopted))[0]).toMatchObject({ hash: baseline?.hash });
  });

  it("comes out with the schema, triggers, kept functions and grants of a new one", async () => {
    const left = await snapshot(adopted);
    expect(left.length).toBeGreaterThan(300);
    expect(left).toEqual(await snapshot(fresh));
  });

  it("keeps the functions dbmate made, for the old code during the deploy", async () => {
    const { rows } = await adopted.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE pronamespace = 'discord_bot'::regnamespace
        AND proname = ANY ($1) ORDER BY proname`,
      [LEGACY_FUNCTIONS],
    );
    expect(rows.map((row) => row.proname)).toEqual(
      [...LEGACY_FUNCTIONS].sort(),
    );
  });

  it("a second run changes nothing", async () => {
    const before = await snapshot(adopted);
    expect(await migrateAsOwner(adopted)).toBe("already_ledgered");
    expect(await snapshot(adopted)).toEqual(before);
    expect(await ledger(adopted)).toEqual(await ledger(fresh));
  });
});

describe("a new database", () => {
  it("has no dbmate ledger, and a later run finds its own record", async () => {
    await fresh.exec(`SET ROLE ${MIGRATION_OWNER}`);
    try {
      expect(await adoptDbmateDatabase(fresh)).toBe("already_ledgered");
    } finally {
      await fresh.exec("RESET ROLE");
    }
    const { rows } = await fresh.query<{ ledger: string | null }>(
      "SELECT to_regclass('discord_bot.schema_migrations')::text AS ledger",
    );
    expect(rows).toEqual([{ ledger: null }]);
  });
});

describe("a database that is not exactly where dbmate left it", () => {
  it.each([
    [
      "one file behind",
      "DELETE FROM discord_bot.schema_migrations WHERE version = '20261119000300'",
    ],
    [
      "a file this code has not seen",
      "INSERT INTO discord_bot.schema_migrations (version) VALUES ('20991231000000')",
    ],
  ])(
    "is refused when it is %s, and nothing is written",
    async (_name, change) => {
      const db = await createLegacyDb();
      try {
        await db.exec(change);
        await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
        const refused = await adoptDbmateDatabase(db).catch(
          (error: unknown) => error,
        );
        expect(String(refused)).toMatch(/schema_migrations holds/);
        await db.exec("RESET ROLE");
        const { rows } = await db.query<{ ledger: string | null }>(
          "SELECT to_regclass('discord_bot.drizzle_migrations')::text AS ledger",
        );
        expect(rows).toEqual([{ ledger: null }]);
      } finally {
        await db.close();
      }
    },
  );
});
