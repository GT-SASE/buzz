import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  describe.each(ALL_TABLES)("%s", (table) => {
    it("bot_app can read the seeded row", async () => {
      const rows = await queryAs(
        db,
        "bot_app",
        `SELECT * FROM public.${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it.each([OTHER_ROLE])("%s cannot read or write", async (role) => {
      for (const sql of [
        `SELECT * FROM public.${table}`,
        `INSERT INTO public.${table} DEFAULT VALUES`,
        `DELETE FROM public.${table}`,
      ]) {
        expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    });
  });

  describe.each([
    ["config_audit", "guild_id"],
    ["event_reminder_log", "state"],
    ["event_step_assignees", "removed_at"],
    ["event_steps", "status"],
    ["guild_config", "guild_id"],
    ["job_runs", "job_name"],
    ["managed_channels", "guild_id"],
    ["reminder_log", "task_id"],
    ["setup_drafts", "fingerprint"],
  ])("direct writes to %s", (table, column) => {
    it("bot_app cannot insert", async () => {
      const code = await errorCodeOf(
        queryAs(db, "bot_app", `INSERT INTO public.${table} DEFAULT VALUES`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app cannot update", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.${table} SET ${column} = ${column}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("job_runs", () => {
    it.each([
      ["started_at", "now()"],
      ["heartbeat_at", "now()"],
      ["status", "'succeeded'"],
      ["finished_at", "now()"],
      ["results", "'{}'"],
      ["error", "NULL"],
    ])("bot_app cannot set %s directly", async (column, value) => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "bot_app",
          `UPDATE public.job_runs SET ${column} = ${value}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("soft deletes", () => {
    let eventId: string;
    let taskId: string;

    beforeAll(async () => {
      const guild = await insertGuild(db);
      eventId = await insertEvent(db, guild);
      taskId = await insertTask(db, guild, eventId);
    });

    it("bot_app can soft-delete a task but cannot undelete it", async () => {
      await queryAs(
        db,
        BOT_APP,
        `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
        [taskId],
      );
      const code = await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          `UPDATE public.tasks SET deleted_at = NULL WHERE id = $1`,
          [taskId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("bot_app cannot undelete an event", async () => {
      await db.query(
        `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
        [eventId],
      );
      const code = await errorCodeOf(
        queryAs(
          db,
          BOT_APP,
          `UPDATE public.events SET deleted_at = NULL WHERE id = $1`,
          [eventId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  it.each([BOT_APP, OTHER_ROLE])("%s cannot disable triggers", async (role) => {
    const code = await errorCodeOf(
      queryAs(db, role, `ALTER TABLE public.tasks DISABLE TRIGGER ALL`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("bot_app cannot call trigger functions directly", async () => {
    const code = await errorCodeOf(
      queryAs(db, "bot_app", `SELECT public.require_open_parent()`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
  describe("bot_app itself", () => {
    it("can log in, and has no other attribute", async () => {
      const { rows } = await db.query(
        `SELECT rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
                rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
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
        },
      ]);
    });

    it("has no password from the migrations: the operator sets one", async () => {
      const { rows } = await db.query(
        `SELECT rolpassword IS NULL AS no_password FROM pg_authid WHERE rolname = $1`,
        [BOT_APP],
      );
      expect(rows).toEqual([{ no_password: true }]);
    });

    it("is a member of no role, so it can neither inherit nor SET ROLE to more", async () => {
      const { rows } = await db.query(
        `SELECT roleid::regrole::text AS role FROM pg_auth_members
         WHERE member = $1::regrole`,
        [BOT_APP],
      );
      expect(rows).toEqual([]);
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
        for (const sql of [
          `DELETE FROM public.${table}`,
          `TRUNCATE public.${table}`,
        ]) {
          expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
        }
      },
    );

    it.each([
      "ALTER TABLE public.tasks ADD COLUMN forged text",
      "ALTER TABLE public.tasks OWNER TO bot_app",
      "ALTER FUNCTION public.claim_interaction(text) SECURITY INVOKER",
      "DROP TABLE public.reminder_log",
      "CREATE TABLE public.forged (id int)",
      "CREATE FUNCTION public.forged() RETURNS int LANGUAGE sql AS 'SELECT 1'",
      "CREATE SCHEMA forged",
      "ALTER ROLE bot_app CREATEROLE",
    ])("cannot run %s", async (sql) => {
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it.each([
      "SELECT * FROM history.row_versions",
      "INSERT INTO history.row_versions DEFAULT VALUES",
      "SELECT history.record_row_version()",
    ])("cannot reach the history schema: %s", async (sql) => {
      expect(await errorCodeOf(queryAs(db, BOT_APP, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it("cannot read the migration ledger or the tables reached only through functions", async () => {
      for (const table of [...NO_GRANT_TABLES, ...LEDGER_TABLES]) {
        expect(
          await errorCodeOf(
            queryAs(db, BOT_APP, `SELECT * FROM public.${table}`),
          ),
        ).toBe(INSUFFICIENT_PRIVILEGE);
      }
    });
  });
});
