import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import {
  BACKUP_ROLE,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createBootstrappedDb,
  createMigratedDb,
  errorCodeOf,
  migrationScripts,
  queryAs,
} from "./harness.ts";

const TABLES = [
  "history.row_versions",
  "public.config_audit",
  "public.events",
  "public.guild_config",
  "public.interaction_claims",
  "public.job_runs",
  "public.managed_channels",
  "public.reminder_log",
  "public.task_reassignments",
  "public.tasks",
];

async function seed(db: PGlite): Promise<void> {
  const guild = await insertGuild(db);
  const eventId = await insertEvent(db, guild);
  await insertTask(db, guild, eventId);
  // An update, so that history.row_versions holds a row as well.
  await queryAs(
    db,
    "service_role",
    `UPDATE public.events SET name = 'Renamed' WHERE id = $1`,
    [eventId],
  );
}

describe("the backup role's temp tables and large objects", () => {
  const canWrite = (db: PGlite) =>
    db.query<{ temp: boolean; lo: boolean }>(
      `SELECT has_database_privilege($1, 'postgres', 'TEMP') AS temp,
              has_function_privilege($1, 'lo_from_bytea(oid, bytea)', 'EXECUTE') AS lo`,
      [BACKUP_ROLE],
    );

  it("a migration role that may not revoke them still migrates, and they stay open", async () => {
    const db = await createMigratedDb();
    try {
      expect((await canWrite(db)).rows).toEqual([{ temp: true, lo: true }]);
    } finally {
      await db.close();
    }
  });

  it("a migration role that may revoke them closes them", async () => {
    const db = await createBootstrappedDb();
    try {
      for (const script of migrationScripts()) {
        // This session's role is a superuser, as the owner of these objects would be.
        await db.exec(
          script.includes("REVOKE TEMP ON DATABASE")
            ? script.replace(`SET LOCAL ROLE ${MIGRATION_OWNER};`, "")
            : script,
        );
      }

      expect((await canWrite(db)).rows).toEqual([{ temp: false, lo: false }]);
      for (const sql of [
        `SELECT lo_from_bytea(0, '\\x00')`,
        `SELECT lo_create(0)`,
        `SELECT lo_creat(-1)`,
        `SELECT lo_unlink(0)`,
      ]) {
        expect(await errorCodeOf(queryAs(db, BACKUP_ROLE, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    } finally {
      await db.close();
    }
  });
});

describe("the backup role's view of the applied migrations", () => {
  const CREATE_RECORD = `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[],
      name text
    );
    INSERT INTO supabase_migrations.schema_migrations (version, statements)
    VALUES ('20261104000001', ARRAY['SELECT 1']);`;
  const GIVE_TO_OWNER = `
    ALTER SCHEMA supabase_migrations OWNER TO ${MIGRATION_OWNER};
    ALTER TABLE supabase_migrations.schema_migrations OWNER TO ${MIGRATION_OWNER};`;

  async function migrate(setup: string): Promise<PGlite> {
    const db = await createBootstrappedDb();
    await db.exec(setup);
    for (const script of migrationScripts()) {
      await db.exec(script);
    }
    return db;
  }

  it("can read the versions and nothing else in that table", async () => {
    const db = await migrate(CREATE_RECORD + GIVE_TO_OWNER);
    try {
      expect(
        await queryAs(
          db,
          BACKUP_ROLE,
          `SELECT version FROM supabase_migrations.schema_migrations ORDER BY version`,
        ),
      ).toEqual([{ version: "20261104000001" }]);
      for (const sql of [
        `SELECT statements FROM supabase_migrations.schema_migrations`,
        `INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('1')`,
        `DELETE FROM supabase_migrations.schema_migrations`,
      ]) {
        expect(await errorCodeOf(queryAs(db, BACKUP_ROLE, sql))).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      }
    } finally {
      await db.close();
    }
  });

  it("still migrates if the migration's role does not own that table", async () => {
    const db = await migrate(CREATE_RECORD);
    try {
      expect(
        await errorCodeOf(
          queryAs(
            db,
            BACKUP_ROLE,
            `SELECT version FROM supabase_migrations.schema_migrations`,
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await db.close();
    }
  });

  it("still migrates where that table does not exist", async () => {
    const db = await createMigratedDb();
    try {
      const { rows } = await db.query(
        `SELECT to_regclass('supabase_migrations.schema_migrations') AS record`,
      );
      expect(rows).toEqual([{ record: null }]);
    } finally {
      await db.close();
    }
  });
});

describe("backup role, where the platform refuses BYPASSRLS", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
    await seed(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("is an unprivileged role that cannot log in until the owner enables it", async () => {
    const { rows } = await db.query(
      `SELECT r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
              r.rolbypassrls, r.rolinherit, a.rolpassword IS NULL AS no_password, r.rolconfig
       FROM pg_roles r
       JOIN pg_authid a ON a.oid = r.oid
       WHERE r.rolname = $1`,
      [BACKUP_ROLE],
    );
    expect(rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
        rolinherit: false,
        no_password: true,
        rolconfig: ["default_transaction_read_only=on"],
      },
    ]);
  });

  it("is a member of no role, so SET ROLE cannot reach postgres or the owner", async () => {
    // SET ROLE itself cannot be tried here: the harness's session user is a superuser,
    // which may switch to any role, so the catalog is the honest check.
    const { rows } = await db.query(
      `SELECT roleid FROM pg_auth_members WHERE member = $1::regrole`,
      [BACKUP_ROLE],
    );
    expect(rows).toEqual([]);

    for (const target of ["postgres", MIGRATION_OWNER, "service_role"]) {
      const member = await db.query(
        `SELECT pg_has_role($1, $2, 'MEMBER') AS member`,
        [BACKUP_ROLE, target],
      );
      expect(member.rows).toEqual([{ member: false }]);
    }
  });

  it("can read every table in the app's schemas", async () => {
    const { rows } = await db.query<{ name: string; readable: boolean }>(
      `SELECT n.nspname || '.' || c.relname AS name,
              has_table_privilege($1, c.oid, 'SELECT') AS readable
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('public', 'history') AND c.relkind IN ('r', 'p')
       ORDER BY 1`,
      [BACKUP_ROLE],
    );
    expect(rows.map((row) => row.name)).toEqual(TABLES);
    expect(rows.filter((row) => !row.readable)).toEqual([]);
  });

  it.each(TABLES)("reads every row of %s through its policy", async (table) => {
    const owner = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    const backup = await queryAs<{ count: number }>(
      db,
      BACKUP_ROLE,
      `SELECT count(*)::int AS count FROM ${table}`,
    );
    expect(backup).toEqual(owner.rows);
  });

  it("sees real rows, including history", async () => {
    const rows = await queryAs<{ count: number }>(
      db,
      BACKUP_ROLE,
      `SELECT count(*)::int AS count FROM history.row_versions`,
    );
    expect(rows[0]?.count).toBeGreaterThan(0);
  });

  it("fails as pg_dump would without --enable-row-security", async () => {
    await db.exec(`SET ROLE ${BACKUP_ROLE}; SET row_security = off;`);
    try {
      expect(
        await errorCodeOf(db.query(`SELECT count(*) FROM public.tasks`)),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    } finally {
      await db.exec(`RESET row_security; RESET ROLE;`);
    }
  });

  it.each(TABLES)("holds no privilege to change %s", async (table) => {
    const { rows } = await db.query(
      `SELECT has_table_privilege($1, $2, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS can`,
      [BACKUP_ROLE, table],
    );
    expect(rows).toEqual([{ can: false }]);
  });

  it.each(TABLES)("is refused when it tries to change %s", async (table) => {
    for (const sql of [
      `INSERT INTO ${table} DEFAULT VALUES`,
      `DELETE FROM ${table}`,
      `TRUNCATE ${table}`,
      `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`,
      `DROP TABLE ${table}`,
    ]) {
      expect(await errorCodeOf(queryAs(db, BACKUP_ROLE, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it("can call no function, including the ones that change data", async () => {
    const { rows } = await db.query(
      `SELECT p.proname
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ('public', 'history')
         AND has_function_privilege($1, p.oid, 'EXECUTE')`,
      [BACKUP_ROLE],
    );
    expect(rows).toEqual([]);
    expect(
      await errorCodeOf(
        queryAs(db, BACKUP_ROLE, `SELECT public.claim_interaction('1')`),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("can read a sequence's position but not advance it, and can create nothing", async () => {
    await queryAs(
      db,
      BACKUP_ROLE,
      `SELECT last_value FROM public.config_audit_id_seq`,
    );
    for (const sql of [
      `SELECT nextval('public.config_audit_id_seq')`,
      `SELECT setval('history.row_versions_id_seq', 1)`,
      `CREATE TABLE public.backup_probe (id int)`,
      `CREATE TABLE history.backup_probe (id int)`,
      `CREATE SCHEMA backup_probe`,
    ]) {
      expect(await errorCodeOf(queryAs(db, BACKUP_ROLE, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it("does not open history or any table to the bot's or public roles", async () => {
    for (const role of ["anon", "authenticated", "service_role"] as const) {
      expect(
        await errorCodeOf(
          queryAs(db, role, `SELECT * FROM history.row_versions`),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await errorCodeOf(
          queryAs(db, role, `SELECT * FROM public.interaction_claims`),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });
});

describe("backup role, where the owner can grant BYPASSRLS", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createBootstrappedDb();
    await db.exec(`ALTER ROLE ${MIGRATION_OWNER} BYPASSRLS`);
    for (const script of migrationScripts()) {
      await db.exec(script);
    }
    await seed(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("takes BYPASSRLS and creates no policies", async () => {
    const { rows } = await db.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [BACKUP_ROLE],
    );
    expect(rows).toEqual([{ rolbypassrls: true }]);
    const policies = await db.query(`SELECT policyname FROM pg_policies`);
    expect(policies.rows).toEqual([]);
  });

  it("reads rows with row security on or off, so one pg_dump command fits both paths", async () => {
    for (const setting of ["on", "off"]) {
      await db.exec(`SET ROLE ${BACKUP_ROLE}; SET row_security = ${setting};`);
      try {
        const { rows } = await db.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM public.tasks`,
        );
        expect(rows[0]?.count).toBeGreaterThan(0);
      } finally {
        await db.exec(`RESET row_security; RESET ROLE;`);
      }
    }
  });

  it("still cannot change app data", async () => {
    expect(
      await errorCodeOf(queryAs(db, BACKUP_ROLE, `DELETE FROM public.tasks`)),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
