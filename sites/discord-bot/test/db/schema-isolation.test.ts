/**
 * The bot shares a database with buzz, whose tables live in public. These tests put a
 * stand-in for buzz's tables in public before the bot's migrations run, then check that
 * the migrations leave public as they found it, that every bot object is in discord_bot,
 * that bot_app can reach nothing in public, and that PUBLIC reaches nothing in discord_bot.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BOT_APP,
  HOOK_TIMEOUT_MS,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  queryAs,
} from "./harness.ts";

/** What the migrations must not change: everything in public, and the owner's defaults. */
const PUBLIC_SNAPSHOT = `
  SELECT 'relation' AS kind, c.relname::text AS name, c.relkind::text AS detail,
         coalesce(c.relacl::text, '') AS acl
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'column', a.attrelid::regclass::text || '.' || a.attname, format_type(a.atttypid, a.atttypmod), ''
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   WHERE c.relnamespace = 'public'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'function', p.proname::text, pg_get_function_identity_arguments(p.oid), coalesce(p.proacl::text, '')
    FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'type', t.typname::text, t.typtype::text, coalesce(t.typacl::text, '')
    FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace
  UNION ALL
  SELECT 'schema', nspname::text, nspowner::regrole::text, coalesce(nspacl::text, '')
    FROM pg_namespace WHERE nspname = 'public'
  UNION ALL
  SELECT 'default_acl', defaclrole::regrole::text, defaclobjtype::text, defaclacl::text
    FROM pg_default_acl
  ORDER BY 1, 2, 3`;

/** Schemas the bot may put nothing in. discord_bot is the only one it makes. */
const OTHER_SCHEMAS =
  "('pg_catalog', 'information_schema', 'public', 'discord_bot')";

let db: PGlite;
let publicBefore: unknown[];

beforeAll(async () => {
  db = await createMigratedDb(async (fresh) => {
    // A stand-in for buzz: tables with a foreign key, a sequence and an enum. buzz has no
    // functions; a function made in public would be open to PUBLIC by Postgres default.
    await fresh.exec(`
      CREATE TYPE public.buzz_role AS ENUM ('member', 'officer');
      CREATE TABLE public.buzz_member (id serial PRIMARY KEY, secret text NOT NULL, role public.buzz_role);
      CREATE TABLE public.buzz_dues (member_id int REFERENCES public.buzz_member (id), cents int);
      INSERT INTO public.buzz_member (secret) VALUES ('buzz data');
    `);
    publicBefore = (await fresh.query(PUBLIC_SNAPSHOT)).rows;
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await db.close();
});

describe("the bot's migrations next to buzz's tables", () => {
  it("leave public, its grants and the owner's default privileges exactly as they were", async () => {
    expect(publicBefore.length).toBeGreaterThan(0);
    expect((await db.query(PUBLIC_SNAPSHOT)).rows).toEqual(publicBefore);
  });

  it("leave buzz's rows alone", async () => {
    const { rows } = await db.query("SELECT secret FROM public.buzz_member");
    expect(rows).toEqual([{ secret: "buzz data" }]);
  });

  it("put every table, function and type, and the migration ledger, in discord_bot", async () => {
    const { rows } = await db.query<{ kind: string; name: string }>(
      `SELECT 'relation' AS kind, c.relnamespace::regnamespace::text || '.' || c.relname AS name
         FROM pg_class c
        WHERE c.relnamespace::regnamespace::text NOT IN ${OTHER_SCHEMAS}
          AND c.relnamespace::regnamespace::text NOT LIKE 'pg_toast%'
          AND c.relnamespace::regnamespace::text NOT LIKE 'pg_temp%'
       UNION ALL
       SELECT 'function', p.pronamespace::regnamespace::text || '.' || p.proname
         FROM pg_proc p WHERE p.pronamespace::regnamespace::text NOT IN ${OTHER_SCHEMAS}
       UNION ALL
       SELECT 'type', t.typnamespace::regnamespace::text || '.' || t.typname
         FROM pg_type t
        WHERE t.typnamespace::regnamespace::text NOT IN ${OTHER_SCHEMAS}
          AND t.typnamespace::regnamespace::text NOT LIKE 'pg_toast%'
          AND t.typnamespace::regnamespace::text NOT LIKE 'pg_temp%'`,
    );
    expect(rows).toEqual([]);

    const ledger = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM discord_bot.drizzle_migrations",
    );
    expect(ledger.rows[0]?.n).toBeGreaterThan(0);

    const inPublic = await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
        WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
        ORDER BY relname`,
    );
    expect(inPublic.rows.map((row) => row.relname)).toEqual([
      "buzz_dues",
      "buzz_member",
      "buzz_member_id_seq",
    ]);
  });
});

describe("bot_app and buzz's tables", () => {
  it("holds no privilege on any relation in public", async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND (has_table_privilege($1, c.oid, 'SELECT') OR has_table_privilege($1, c.oid, 'INSERT')
            OR has_table_privilege($1, c.oid, 'UPDATE') OR has_table_privilege($1, c.oid, 'DELETE')
            OR has_table_privilege($1, c.oid, 'TRUNCATE') OR has_table_privilege($1, c.oid, 'REFERENCES')
            OR has_table_privilege($1, c.oid, 'TRIGGER'))
       UNION ALL
       SELECT c.relname FROM pg_class c
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'S'
          AND (has_sequence_privilege($1, c.oid, 'USAGE') OR has_sequence_privilege($1, c.oid, 'SELECT'))
`,
      [BOT_APP],
    );
    expect(rows).toEqual([]);
  });

  it.each([
    "SELECT * FROM public.buzz_member",
    "INSERT INTO public.buzz_member (secret) VALUES ('x')",
    "UPDATE public.buzz_member SET secret = 'x'",
    "DELETE FROM public.buzz_member",
    "TRUNCATE public.buzz_member",
    "SELECT * FROM public.buzz_dues",
    "SELECT nextval('public.buzz_member_id_seq')",
    "ALTER TABLE public.buzz_member ADD COLUMN forged text",
    "DROP TABLE public.buzz_member",
    "CREATE TABLE public.forged (id int)",
  ])("refuses bot_app %s", async (sql) => {
    expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    const { rows } = await db.query(
      "SELECT count(*)::int AS n FROM public.buzz_member",
    );
    expect(rows).toEqual([{ n: 1 }]);
  });

  it("sees no buzz table by bare name, since nothing sets bot_app's search_path", async () => {
    // A bare name reaches public, which bot_app cannot read, so the bot's statements
    // must name discord_bot, as src/db does.
    expect(
      await errorCodeOf(queryAs(db, BOT_APP, "SELECT * FROM buzz_member")),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    const { rows } = await db.query<{ setconfig: string[] | null }>(
      `SELECT setconfig FROM pg_db_role_setting WHERE setrole = $1::regrole`,
      [BOT_APP],
    );
    for (const { setconfig } of rows) {
      expect(
        (setconfig ?? []).filter((item) => item.startsWith("search_path")),
      ).toEqual([]);
    }
  });
});

describe("PUBLIC and discord_bot", () => {
  it("has no grant on the schema or on any table, sequence, function or type in it", async () => {
    // Grantee 0 in an ACL is PUBLIC.
    const { rows } = await db.query<{ kind: string; name: string }>(
      `SELECT 'relation' AS kind, c.relname::text AS name
         FROM pg_class c, aclexplode(c.relacl) AS a
        WHERE c.relnamespace = 'discord_bot'::regnamespace AND a.grantee = 0
       UNION ALL
       SELECT 'function', p.proname::text
         FROM pg_proc p, aclexplode(p.proacl) AS a
        WHERE p.pronamespace = 'discord_bot'::regnamespace AND a.grantee = 0
       UNION ALL
       SELECT 'type', t.typname::text
         FROM pg_type t, aclexplode(t.typacl) AS a
        WHERE t.typnamespace = 'discord_bot'::regnamespace AND a.grantee = 0
       UNION ALL
       SELECT 'schema', n.nspname::text
         FROM pg_namespace n, aclexplode(n.nspacl) AS a
        WHERE n.nspname = 'discord_bot' AND a.grantee = 0`,
    );
    expect(rows).toEqual([]);
  });

  it("leaves bot_app with usage on the schema and no way to create anything in it", async () => {
    const { rows } = await db.query(
      `SELECT has_schema_privilege($1, 'discord_bot', 'USAGE') AS usage,
              has_schema_privilege($1, 'discord_bot', 'CREATE') AS "create"`,
      [BOT_APP],
    );
    expect(rows).toEqual([{ usage: true, create: false }]);
  });

  it("keeps the migration owner as the owner of the schema", async () => {
    const { rows } = await db.query(
      "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'discord_bot'",
    );
    expect(rows).toEqual([{ owner: MIGRATION_OWNER }]);
  });
});
