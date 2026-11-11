import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  API_ROLES,
  BACKUP_ROLE,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  queryAs,
} from "./harness.ts";

const READ_ONLY_TABLES = [
  "config_audit",
  "guild_config",
  "managed_channels",
  "reminder_log",
];
const ALL_TABLES = [...READ_ONLY_TABLES, "events", "job_runs", "tasks"].sort();
/** Reached only through a function, so service_role has no grant on it. */
const NO_GRANT_TABLES = ["interaction_claims", "task_reassignments"];
/** Everything the backup reads, including tables the bot's role cannot reach. */
const BACKUP_TABLES = [
  ...ALL_TABLES,
  ...NO_GRANT_TABLES,
  "row_versions",
].sort();

/** Every table-level grant allowed on the app's schemas. Anything else fails the test. */
const EXPECTED_TABLE_GRANTS = [
  "service_role events SELECT",
  "service_role job_runs SELECT",
  "service_role tasks SELECT",
  ...READ_ONLY_TABLES.map((table) => `service_role ${table} SELECT`),
  ...BACKUP_TABLES.map((table) => `${BACKUP_ROLE} ${table} SELECT`),
].sort();

/** The only columns of events and tasks that can be written. Anything else fails the test. */
const EXPECTED_COLUMN_GRANTS = [
  ...[
    "channel_id",
    "created_by",
    "event_date",
    "guild_id",
    "name",
    "thread_id",
    "thread_status",
  ].map((column) => `service_role events.${column} INSERT`),
  ...[
    "assignee_id",
    "created_by",
    "description",
    "due_date",
    "event_id",
    "guild_id",
  ].map((column) => `service_role tasks.${column} INSERT`),
  ...[
    "event_date",
    "name",
    "overview_message_id",
    "status",
    "thread_id",
    "thread_status",
  ].map((column) => `service_role events.${column} UPDATE`),
  ...[
    "assignee_id",
    "completed_at",
    "deleted_at",
    "description",
    "due_date",
    "status",
  ].map((column) => `service_role tasks.${column} UPDATE`),
  ...["actor_id", "guild_id", "task_id"].map(
    (column) => `service_role task_reassignments.${column} INSERT`,
  ),
].sort();

/** Every routine a role other than the owner can call. Trigger functions need no grant. */
const EXPECTED_ROUTINE_GRANTS = [
  "service_role apply_config_change EXECUTE",
  "service_role apply_role_bindings EXECUTE",
  "service_role begin_job_run EXECUTE",
  "service_role claim_event_post_attempt EXECUTE",
  "service_role claim_interaction EXECUTE",
  "service_role claim_reminder EXECUTE",
  "service_role clear_thread_refusals EXECUTE",
  "service_role expire_interaction_claims EXECUTE",
  "service_role finish_job_run EXECUTE",
  "service_role mark_channel_unavailable EXECUTE",
  "service_role mark_reminder_sent EXECUTE",
  "service_role mark_reminder_skipped EXECUTE",
  "service_role reclaim_reminder EXECUTE",
  "service_role record_reminder_refused EXECUTE",
  "service_role record_thread_refusal EXECUTE",
  "service_role release_event_post_attempt EXECUTE",
  "service_role soft_delete_event EXECUTE",
];

const EXPECTED_TYPE_GRANTS = [
  "discord_id",
  "event_status",
  "job_run_status",
  "managed_channel_status",
  "reminder_kind",
  "reminder_state",
  "task_status",
  "thread_status",
].map((type) => `service_role ${type} USAGE`);

/** Every column holding a Discord ID. A new one must be added here and use the domain. */
const DISCORD_ID_COLUMNS = [
  "config_audit.actor_id",
  "config_audit.guild_id",
  "events.channel_id",
  "events.created_by",
  "events.guild_id",
  "events.overview_message_id",
  "events.thread_id",
  "guild_config.admin_role_id",
  "guild_config.guild_id",
  "guild_config.officer_role_id",
  "interaction_claims.interaction_id",
  "managed_channels.channel_id",
  "managed_channels.guild_id",
  "reminder_log.message_id",
  "task_reassignments.actor_id",
  "task_reassignments.guild_id",
  "tasks.assignee_id",
  "tasks.created_by",
  "tasks.guild_id",
];

const FOREIGN_KEYS = [
  "config_audit references guild_config",
  "events references managed_channels",
  "managed_channels references guild_config",
  "reminder_log references tasks",
  "task_reassignments references guild_config",
  "task_reassignments references tasks",
  "tasks references events",
];

describe("access", () => {
  let db: PGlite;

  /** Non-owner grants from a catalog ACL, as "grantee object privilege". PUBLIC is grantee 0. */
  async function aclGrants(
    from: string,
    name: string,
    acl: string,
    owner: string,
    where: string,
  ): Promise<string[]> {
    const { rows } = await db.query<{ grant: string }>(
      `SELECT coalesce(r.rolname, 'PUBLIC') || ' ' || ${name} || ' ' || a.privilege_type AS grant
       FROM ${from}
       CROSS JOIN LATERAL aclexplode(${acl}) AS a
       LEFT JOIN pg_roles r ON r.oid = a.grantee
       WHERE ${where} AND a.grantee <> ${owner}`,
    );
    return rows.map((row) => row.grant).sort();
  }

  beforeAll(async () => {
    db = await createMigratedDb();
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    const taskId = await insertTask(db, guild, eventId);
    await queryAs(
      db,
      "service_role",
      `SELECT public.claim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}')`,
      [taskId],
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

  describe("exact grant lists", () => {
    it("the public schema holds exactly the expected tables", async () => {
      const { rows } = await db.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      expect(rows.map((row) => row.tablename)).toEqual(
        [...ALL_TABLES, ...NO_GRANT_TABLES].sort(),
      );
    });

    it("information_schema.role_table_grants matches", async () => {
      const { rows } = await db.query<{ grant: string }>(
        `SELECT grantee || ' ' || table_name || ' ' || privilege_type AS grant
         FROM information_schema.role_table_grants
         WHERE table_schema IN ('public', 'history') AND grantee <> $1`,
        [MIGRATION_OWNER],
      );
      expect(rows.map((row) => row.grant).sort()).toEqual(
        EXPECTED_TABLE_GRANTS,
      );
    });

    it("information_schema.role_routine_grants matches", async () => {
      const { rows } = await db.query<{ grant: string }>(
        `SELECT grantee || ' ' || routine_name || ' ' || privilege_type AS grant
         FROM information_schema.role_routine_grants
         WHERE routine_schema IN ('public', 'history') AND grantee <> $1`,
        [MIGRATION_OWNER],
      );
      expect(rows.map((row) => row.grant).sort()).toEqual(
        EXPECTED_ROUTINE_GRANTS,
      );
    });

    it("schema grants match", async () => {
      const grants = await aclGrants(
        "pg_namespace n",
        "n.nspname",
        `coalesce(n.nspacl, acldefault('n', n.nspowner))`,
        "n.nspowner",
        `n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual([
        `${BACKUP_ROLE} history USAGE`,
        `${BACKUP_ROLE} public USAGE`,
        "service_role public USAGE",
      ]);
    });

    it("only the backup role has a grant on any sequence, and only to read it", async () => {
      const grants = await aclGrants(
        `pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace`,
        "c.relname",
        `coalesce(c.relacl, acldefault('S', c.relowner))`,
        "c.relowner",
        `c.relkind = 'S' AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual([
        `${BACKUP_ROLE} config_audit_id_seq SELECT`,
        `${BACKUP_ROLE} row_versions_id_seq SELECT`,
        `${BACKUP_ROLE} task_reassignments_id_seq SELECT`,
      ]);
    });

    it("type and domain grants match", async () => {
      const grants = await aclGrants(
        `pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace`,
        "t.typname",
        `coalesce(t.typacl, acldefault('T', t.typowner))`,
        "t.typowner",
        `t.typtype IN ('e', 'd') AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual(EXPECTED_TYPE_GRANTS);
    });

    it("column grants match", async () => {
      const grants = await aclGrants(
        `pg_attribute att JOIN pg_class c ON c.oid = att.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace`,
        `c.relname || '.' || att.attname`,
        "att.attacl",
        "c.relowner",
        `att.attacl IS NOT NULL AND n.nspname IN ('public', 'history')`,
      );
      expect(grants).toEqual(EXPECTED_COLUMN_GRANTS);
    });
  });

  describe("catalog rules", () => {
    it("row level security is on, with policies for the backup role alone", async () => {
      const { rows: tables } = await db.query<{
        relname: string;
        relrowsecurity: boolean;
      }>(
        `SELECT c.relname, c.relrowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')`,
      );
      expect(tables.length).toBeGreaterThanOrEqual(ALL_TABLES.length);
      expect(tables.filter((table) => !table.relrowsecurity)).toEqual([]);

      // This harness's owner has no BYPASSRLS, so the migration takes its policy path.
      // backup-role.test.ts covers the other path.
      const { rows: policies } = await db.query(
        `SELECT tablename, roles::text[] AS roles, cmd, qual
         FROM pg_policies
         ORDER BY tablename`,
      );
      expect(policies).toEqual(
        BACKUP_TABLES.map((tablename) => ({
          tablename,
          roles: [BACKUP_ROLE],
          cmd: "SELECT",
          qual: "true",
        })),
      );
    });

    it("the open-parent guard's comment says what it does for a removed channel", async () => {
      const { rows } = await db.query<{ comment: string }>(
        `SELECT obj_description('public.require_open_parent()'::regprocedure) AS comment`,
      );
      expect(rows[0]?.comment).toContain(
        "A task on an event in a removed channel is allowed",
      );
    });

    it("every function has a pinned, empty search_path", async () => {
      const { rows } = await db.query(
        `SELECT p.proname, p.proconfig
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname IN ('public', 'history')
           AND p.proconfig IS DISTINCT FROM ARRAY['search_path=""']`,
      );
      expect(rows).toEqual([]);
    });

    it("no function in the public schema is overloaded", async () => {
      // An overload could be picked over the intended function by argument types, and
      // grants name one signature, so a second one would need its own review.
      const { rows } = await db.query(
        `SELECT p.proname, count(*)::int AS versions
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
         GROUP BY p.proname
         HAVING count(*) > 1`,
      );
      expect(rows).toEqual([]);
    });

    it("every Discord ID column uses the domain, and no other column does", async () => {
      const { rows } = await db.query<{ col: string }>(
        `SELECT table_name || '.' || column_name AS col
         FROM information_schema.columns
         WHERE table_schema = 'public' AND domain_name = 'discord_id'`,
      );
      expect(rows.map((row) => row.col).sort()).toEqual(DISCORD_ID_COLUMNS);
    });

    it("stores Discord IDs as text", async () => {
      const { rows } = await db.query(
        `SELECT DISTINCT data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND domain_name = 'discord_id'`,
      );
      expect(rows).toEqual([{ data_type: "text" }]);
    });

    it("no foreign key cascades, so a hard delete cannot take other rows with it", async () => {
      const { rows } = await db.query<{
        fk: string;
        confdeltype: string;
        confupdtype: string;
      }>(
        `SELECT conrelid::regclass::text || ' references ' || confrelid::regclass::text AS fk,
                confdeltype::text AS confdeltype,
                confupdtype::text AS confupdtype
         FROM pg_constraint
         WHERE contype = 'f' AND connamespace = 'public'::regnamespace
         ORDER BY 1`,
      );
      expect(rows.map((row) => row.fk.replaceAll("public.", ""))).toEqual(
        FOREIGN_KEYS,
      );
      expect(
        rows.filter(
          (row) => row.confdeltype !== "a" || row.confupdtype !== "a",
        ),
      ).toEqual([]);
    });
  });

  describe.each(ALL_TABLES)("%s", (table) => {
    it("service_role cannot DELETE", async () => {
      const code = await errorCodeOf(
        queryAs(db, "service_role", `DELETE FROM public.${table}`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("service_role cannot TRUNCATE", async () => {
      const code = await errorCodeOf(
        queryAs(db, "service_role", `TRUNCATE public.${table} CASCADE`),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("service_role can read the seeded row", async () => {
      const rows = await queryAs(
        db,
        "service_role",
        `SELECT * FROM public.${table}`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it.each(["anon", "authenticated"] as const)(
      "%s cannot read or write",
      async (role) => {
        for (const sql of [
          `SELECT * FROM public.${table}`,
          `INSERT INTO public.${table} DEFAULT VALUES`,
          `DELETE FROM public.${table}`,
        ]) {
          expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
            INSUFFICIENT_PRIVILEGE,
          );
        }
      },
    );
  });

  describe.each([
    ["config_audit", "guild_id"],
    ["guild_config", "guild_id"],
    ["job_runs", "job_name"],
    ["managed_channels", "guild_id"],
    ["reminder_log", "task_id"],
  ])("direct writes to %s", (table, column) => {
    it("service_role cannot insert", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `INSERT INTO public.${table} DEFAULT VALUES`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("service_role cannot update", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `UPDATE public.${table} SET ${column} = ${column}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("job_runs", () => {
    it("service_role cannot add a run dated in the future", async () => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `INSERT INTO public.job_runs (job_name, status, started_at, finished_at)
           VALUES ('reminders', 'succeeded', '2099-01-01', '2099-01-01')`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it.each([
      ["started_at", "now()"],
      ["heartbeat_at", "now()"],
      ["status", "'succeeded'"],
      ["finished_at", "now()"],
      ["results", "'{}'"],
      ["error", "NULL"],
    ])("service_role cannot set %s directly", async (column, value) => {
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `UPDATE public.job_runs SET ${column} = ${value}`,
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });
  });

  describe("protected columns", () => {
    let guild: GuildFixture;
    let eventId: string;
    let taskId: string;

    beforeAll(async () => {
      guild = await insertGuild(db);
      eventId = await insertEvent(db, guild);
      taskId = await insertTask(db, guild, eventId);
    });

    it.each([
      ["events.deleted_at", `UPDATE public.events SET deleted_at = now()`],
      ["events.guild_id", `UPDATE public.events SET guild_id = guild_id`],
      ["events.channel_id", `UPDATE public.events SET channel_id = channel_id`],
      ["tasks.event_id", `UPDATE public.tasks SET event_id = event_id`],
      ["tasks.guild_id", `UPDATE public.tasks SET guild_id = guild_id`],
      ["tasks.created_by", `UPDATE public.tasks SET created_by = created_by`],
      ["tasks.id", `UPDATE public.tasks SET id = id`],
    ])("service_role cannot change %s", async (_name, sql) => {
      expect(await errorCodeOf(queryAs(db, "service_role", sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });

    it.each([
      ["created_at", "'2000-01-01'"],
      ["updated_at", "'2000-01-01'"],
      ["deleted_at", "now()"],
      ["post_attempt_at", "'2099-01-01'"],
      ["status", "'closed'"],
      ["overview_message_id", "NULL"],
      ["id", "gen_random_uuid()"],
    ])(
      "service_role cannot set events.%s on a new event",
      async (column, value) => {
        const code = await errorCodeOf(
          queryAs(
            db,
            "service_role",
            `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by, ${column})
           VALUES ($1, $2, 'Forged', '2030-01-15', $3, ${value})`,
            [guild.guildId, guild.channelId, fakeId()],
          ),
        );
        expect(code).toBe(INSUFFICIENT_PRIVILEGE);
      },
    );

    it.each([
      ["created_at", "'2000-01-01'"],
      ["updated_at", "'2000-01-01'"],
      ["deleted_at", "now()"],
      ["completed_at", "now()"],
      ["status", "'done'"],
      ["id", "gen_random_uuid()"],
    ])(
      "service_role cannot set tasks.%s on a new task",
      async (column, value) => {
        const code = await errorCodeOf(
          queryAs(
            db,
            "service_role",
            `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by, ${column})
           VALUES ($1, $2, $3, 'Forged', '${FIXTURE_DUE_DATE}', $3, ${value})`,
            [eventId, guild.guildId, fakeId()],
          ),
        );
        expect(code).toBe(INSUFFICIENT_PRIVILEGE);
      },
    );

    it("service_role can still insert with the named columns", async () => {
      const rows = await queryAs(
        db,
        "service_role",
        `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
         VALUES ($1, $2, 'Linked', '2030-01-15', $3, $4, 'active') RETURNING created_at`,
        [guild.guildId, guild.channelId, fakeId(), fakeId()],
      );
      expect(rows).toHaveLength(1);
    });

    it("service_role can soft-delete a single task but cannot undelete an event", async () => {
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
        [taskId],
      );
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `UPDATE public.events SET deleted_at = NULL WHERE id = $1`,
          [eventId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("a task cannot be moved to another event or guild", async () => {
      const other = await insertGuild(db);
      const otherEvent = await insertEvent(db, other);
      const code = await errorCodeOf(
        queryAs(
          db,
          "service_role",
          `UPDATE public.tasks SET event_id = $2, guild_id = $3 WHERE id = $1`,
          [taskId, otherEvent, other.guildId],
        ),
      );
      expect(code).toBe(INSUFFICIENT_PRIVILEGE);
    });

    it("service_role can still make ordinary updates, and updated_at still refreshes", async () => {
      await db.exec(
        `UPDATE public.events SET updated_at = '2000-01-01' WHERE id = '${eventId}'`,
      );
      await queryAs(
        db,
        "service_role",
        `UPDATE public.events SET name = 'Renamed', status = 'closed' WHERE id = $1`,
        [eventId],
      );
      const { rows } = await db.query(
        `SELECT name, status, updated_at > '2000-01-02' AS refreshed FROM public.events WHERE id = $1`,
        [eventId],
      );
      expect(rows).toEqual([
        { name: "Renamed", status: "closed", refreshed: true },
      ]);
    });
  });

  it("row level security still hides rows if grants to anon appear by mistake", async () => {
    await db.exec(
      "BEGIN; GRANT USAGE ON SCHEMA public TO anon; GRANT SELECT ON public.tasks TO anon;",
    );
    try {
      const rows = await queryAs(db, "anon", `SELECT * FROM public.tasks`);
      expect(rows).toEqual([]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it.each(API_ROLES)("%s cannot disable triggers", async (role) => {
    const code = await errorCodeOf(
      queryAs(db, role, `ALTER TABLE public.tasks DISABLE TRIGGER ALL`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("service_role cannot call trigger functions directly", async () => {
    const code = await errorCodeOf(
      queryAs(db, "service_role", `SELECT public.require_open_parent()`),
    );
    expect(code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
