import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
} from "./fixtures.ts";
import {
  BOT_APP,
  INSUFFICIENT_PRIVILEGE,
  OTHER_ROLE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const READ_ONLY_TABLES = [
  "config_audit",
  "event_reminder_log",
  "event_step_assignees",
  "event_steps",
  "guild_config",
  "managed_channels",
  "reminder_log",
  "setup_drafts",
];
const ALL_TABLES = [...READ_ONLY_TABLES, "events", "job_runs", "tasks"].sort();
/** Reached only through functions, so bot_app has no grant on it. */
const NO_GRANT_TABLES = ["interaction_claims", "task_reassignments"];
/** dbmate's record of applied migrations. */
const LEDGER_TABLES = ["schema_migrations"];

describe("access", () => {
  let db: PGlite;

  const refused = async (role: string, sql: string, params?: unknown[]) => {
    expect(await errorCodeOf(queryAs(db, role, sql, params))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  };

  beforeAll(async () => {
    db = await createMigratedDb();
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, eventId);
    await queryAs(
      db,
      "bot_app",
      `SELECT public.claim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}')`,
      [taskId],
    );
    await queryAs(
      db,
      "bot_app",
      `SELECT public.assign_event_step($1, $2, 'budget_sheet', $3, $3)`,
      [eventId, guild.guildId, fakeId()],
    );
    await queryAs(
      db,
      "bot_app",
      // A step reminder can be claimed only for today or yesterday in the guild's zone.
      `SELECT public.claim_event_reminder($1, 'daily_steps', (now() AT TIME ZONE 'America/New_York')::date)`,
      [eventId],
    );
    await queryAs(
      db,
      "bot_app",
      `SELECT public.save_setup_draft($1, $2, $3, $3, $3, $3, $3, $3, 'abcdefgh12345678')`,
      [guild.guildId, fakeId(), fakeId()],
    );
    await insertFinishedJobRun(db, { status: "succeeded" });
    await queryAs(
      db,
      MIGRATION_OWNER,
      `INSERT INTO public.config_audit (guild_id, actor_id, action, new_values, version_after)
       VALUES ($1, $1, 'settings', '{}', 1)`,
      [guild.guildId],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it.each(ALL_TABLES)(
    "bot_app can read %s, and another role cannot read or write it",
    async (table) => {
      const rows = await queryAs(
        db,
        "bot_app",
        `SELECT * FROM public.${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const sql of [
        `SELECT * FROM public.${table}`,
        `INSERT INTO public.${table} DEFAULT VALUES`,
        `DELETE FROM public.${table}`,
      ]) {
        await refused(OTHER_ROLE, sql);
      }
    },
  );

  it.each([
    ["config_audit", "guild_id"],
    ["event_reminder_log", "state"],
    ["event_step_assignees", "removed_at"],
    ["event_steps", "status"],
    ["guild_config", "guild_id"],
    ["job_runs", "status"],
    ["managed_channels", "guild_id"],
    ["reminder_log", "task_id"],
    ["setup_drafts", "fingerprint"],
  ])("bot_app cannot insert into or update %s directly", async (table, col) => {
    await refused("bot_app", `INSERT INTO public.${table} DEFAULT VALUES`);
    await refused("bot_app", `UPDATE public.${table} SET ${col} = ${col}`);
  });

  it.each(["tasks", "events"])(
    "bot_app can soft-delete from %s but cannot undelete",
    async (table) => {
      const guild = await insertGuild(db);
      const eventId = await insertEvent(db, guild);
      const id =
        table === "tasks" ? await insertTask(db, guild, eventId) : eventId;
      const setDeleted = (value: string) =>
        `UPDATE public.${table} SET deleted_at = ${value} WHERE id = $1`;
      if (table === "tasks") {
        await queryAs(db, BOT_APP, setDeleted("now()"), [id]);
      } else {
        await db.query(setDeleted("now()"), [id]);
      }
      await refused(BOT_APP, setDeleted("NULL"), [id]);
    },
  );

  it.each([BOT_APP, OTHER_ROLE])(
    "%s cannot disable triggers or call a trigger function",
    async (role) => {
      await refused(role, `ALTER TABLE public.tasks DISABLE TRIGGER ALL`);
      await refused(role, `SELECT public.require_open_parent()`);
    },
  );

  describe("bot_app itself", () => {
    it("can log in, has no other attribute, no password and no role", async () => {
      const { rows } = await db.query(
        `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolreplication, rolbypassrls, rolpassword IS NULL AS no_password,
                NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member = oid) AS no_roles
         FROM pg_authid WHERE rolname = $1`,
        [BOT_APP],
      );
      expect(rows).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolinherit: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
          rolbypassrls: false,
          no_password: true,
          no_roles: true,
        },
      ]);
    });

    it("owns nothing", async () => {
      const { rows } = await db.query(
        `SELECT 'relation' AS kind FROM pg_class WHERE relowner = $1::regrole
         UNION ALL SELECT 'routine' FROM pg_proc WHERE proowner = $1::regrole
         UNION ALL SELECT 'type' FROM pg_type WHERE typowner = $1::regrole
         UNION ALL SELECT 'schema' FROM pg_namespace WHERE nspowner = $1::regrole
         UNION ALL SELECT 'database' FROM pg_database WHERE datdba = $1::regrole`,
        [BOT_APP],
      );
      expect(rows).toEqual([]);
    });

    it("has a statement timeout and the UTC zone, whatever pooler it comes through", async () => {
      const { rows } = await db.query<{ setting: string }>(
        `SELECT unnest(setconfig) AS setting FROM pg_db_role_setting
         WHERE setrole = $1::regrole`,
        [BOT_APP],
      );
      expect(rows.map((row) => row.setting).sort()).toEqual([
        "TimeZone=UTC",
        "idle_in_transaction_session_timeout=15s",
        "statement_timeout=10s",
      ]);
    });

    it.each([...ALL_TABLES, ...NO_GRANT_TABLES, ...LEDGER_TABLES])(
      "cannot DELETE from or TRUNCATE %s",
      async (table) => {
        await refused(BOT_APP, `DELETE FROM public.${table}`);
        await refused(BOT_APP, `TRUNCATE public.${table}`);
      },
    );

    it.each([...NO_GRANT_TABLES, ...LEDGER_TABLES])(
      "cannot read %s",
      async (table) => {
        await refused(BOT_APP, `SELECT * FROM public.${table}`);
      },
    );

    it.each([
      "ALTER TABLE public.tasks ADD COLUMN forged text",
      "ALTER FUNCTION public.claim_interaction(text) SECURITY INVOKER",
      "CREATE TABLE public.forged (id int)",
      "ALTER ROLE bot_app CREATEROLE",
    ])("cannot run %s", async (sql) => {
      await refused(BOT_APP, sql);
    });
  });
});
