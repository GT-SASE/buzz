/**
 * backup/grant-backup-role.psql, which a recovery runs after the restore. These run the
 * real file as the tables' owner, starting from what the restore filter leaves: every
 * grant in the dump, and no policies.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import {
  BACKUP_ROLE,
  MIGRATION_OWNER,
  createMigratedDb,
  queryAs,
} from "./harness.ts";

const ROOT = join(import.meta.dirname, "..", "..");

function read(...path: string[]): string {
  return readFileSync(join(ROOT, ...path), "utf8");
}

const GRANT_SCRIPT = read("backup", "grant-backup-role.psql");

/** The role check that backup/run-backup.sh really runs. */
function roleCheckSql(): string {
  const sql = /run_sql <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(
    read("backup", "run-backup.sh"),
  )?.[1];
  if (sql === undefined) {
    throw new Error("cannot find the role check in run-backup.sh");
  }
  return sql;
}

async function runScript(db: PGlite): Promise<void> {
  await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
  try {
    await db.exec(GRANT_SCRIPT);
  } finally {
    await db.exec("RESET ROLE");
  }
}

interface RoleCheck {
  unreadable: number;
  hidden: number;
  writable: number;
}

async function roleCheck(db: PGlite): Promise<RoleCheck> {
  const [row] = await queryAs<RoleCheck>(db, BACKUP_ROLE, roleCheckSql());
  if (row === undefined) {
    throw new Error("the role check returned no row");
  }
  return row;
}

async function dropRolePolicies(db: PGlite): Promise<void> {
  const { rows } = await db.query<{ schemaname: string; tablename: string }>(
    `SELECT schemaname, tablename FROM pg_policies WHERE policyname = 'backup_ro_read'`,
  );
  for (const { schemaname, tablename } of rows) {
    await db.exec(
      `DROP POLICY backup_ro_read ON "${schemaname}"."${tablename}"`,
    );
  }
}

/** Every rule that decides what the role can read, as the recovery job compares them. */
async function accessRules(db: PGlite): Promise<unknown[]> {
  const { rows } = await db.query(
    `SELECT 'policy' AS kind, schemaname AS a, tablename AS b, policyname AS c,
            permissive || roles::text || cmd || coalesce(qual, '') AS d
     FROM pg_policies
     UNION ALL
     SELECT 'table', table_schema, table_name, grantee, privilege_type
     FROM information_schema.role_table_grants
     WHERE grantee = '${BACKUP_ROLE}'
     UNION ALL
     SELECT 'sequence', n.nspname, c.relname, '${BACKUP_ROLE}', 'SELECT'
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'history')
       AND CASE WHEN c.relkind = 'S'
                THEN has_sequence_privilege('${BACKUP_ROLE}', c.oid, 'SELECT')
                ELSE false END
     ORDER BY 1, 2, 3, 4, 5`,
  );
  return rows;
}

async function rlsTableCount(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname IN ('public', 'history')
       AND c.relkind IN ('r', 'p') AND c.relrowsecurity`,
  );
  return rows[0]?.count ?? -1;
}

async function policyCount(db: PGlite): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_policies WHERE policyname = 'backup_ro_read'`,
  );
  return rows[0]?.count ?? -1;
}

describe("the recovery grant script, where the platform refuses BYPASSRLS", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await insertTask(db, guild, eventId);
    await queryAs(
      db,
      "service_role",
      `UPDATE public.events SET name = 'Renamed' WHERE id = $1`,
      [eventId],
    );
  });

  afterAll(async () => {
    await db.close();
  });

  it("restores exactly the access the migrations gave, after the restore drops policies", async () => {
    const original = await accessRules(db);
    await dropRolePolicies(db);
    expect(await policyCount(db)).toBe(0);

    await runScript(db);

    expect(await accessRules(db)).toEqual(original);
    expect(await policyCount(db)).toBe(await rlsTableCount(db));
    expect(await roleCheck(db)).toMatchObject({
      unreadable: 0,
      hidden: 0,
      writable: 0,
    });
  });

  it("gives history.row_versions a policy, as row level security would hide it otherwise", async () => {
    const { rows } = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies
       WHERE schemaname = 'history' AND tablename = 'row_versions'
         AND policyname = 'backup_ro_read'`,
    );
    expect(rows[0]?.count).toBe(1);

    const visible = await queryAs<{ count: number }>(
      db,
      BACKUP_ROLE,
      `SELECT count(*)::int AS count FROM history.row_versions`,
    );
    expect(visible[0]?.count).toBeGreaterThan(0);
  });

  it("changes nothing when run again", async () => {
    const before = await accessRules(db);

    await runScript(db);

    expect(await accessRules(db)).toEqual(before);
  });

  it("covers a table no one has told it about", async () => {
    await db.exec(`SET ROLE ${MIGRATION_OWNER}`);
    await db.exec(`CREATE TABLE public.future_table (id integer);
      ALTER TABLE public.future_table ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.future_table FROM PUBLIC, anon, authenticated, service_role;`);
    await db.exec("RESET ROLE");
    await db.exec(`INSERT INTO public.future_table VALUES (1)`);

    // A table lacking both is what the backup job refuses.
    expect(await roleCheck(db)).toMatchObject({ unreadable: 1, hidden: 1 });

    await runScript(db);

    expect(await roleCheck(db)).toMatchObject({ unreadable: 0, hidden: 0 });
    const rows = await queryAs(
      db,
      BACKUP_ROLE,
      `SELECT id FROM public.future_table`,
    );
    expect(rows).toEqual([{ id: 1 }]);
    await db.exec(`DROP TABLE public.future_table`);
  });

  it.each([
    [
      "a table it cannot grant on",
      `CREATE TABLE public.not_the_owners (id integer);`,
      "public.not_the_owners",
    ],
    [
      "a policy that hides every row",
      `ALTER POLICY backup_ro_read ON public.tasks USING (false);`,
      null,
    ],
    [
      "a restrictive policy on top",
      `CREATE POLICY shut ON public.tasks AS RESTRICTIVE FOR SELECT TO ${BACKUP_ROLE} USING (false);`,
      null,
    ],
  ])("fails, rather than finish with %s", async (_name, setup, table) => {
    await db.exec(`BEGIN; ${setup}`);
    try {
      await expect(runScript(db)).rejects.toThrow();
    } finally {
      await db.exec("ROLLBACK");
    }
    if (table !== null) {
      const { rows } = await db.query(
        `SELECT 1 FROM pg_class WHERE oid = to_regclass($1)`,
        [table],
      );
      expect(rows).toEqual([]);
    }
  });
});

describe("the recovery grant script, where the platform allows BYPASSRLS", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
    await dropRolePolicies(db);
    await db.exec(`ALTER ROLE ${MIGRATION_OWNER} BYPASSRLS`);
    await runScript(db);
  });

  afterAll(async () => {
    await db.close();
  });

  it("uses the attribute and creates no policies", async () => {
    const { rows } = await db.query(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = '${BACKUP_ROLE}'`,
    );
    expect(rows).toEqual([{ rolbypassrls: true }]);
    expect(await policyCount(db)).toBe(0);
    expect(await roleCheck(db)).toMatchObject({ unreadable: 0, hidden: 0 });
  });
});

describe("the recovery grant script and the applied migrations", () => {
  it("gives read access to the versions once the CLI has created the table", async () => {
    const db = await createMigratedDb();
    try {
      await db.exec(`
        CREATE SCHEMA supabase_migrations AUTHORIZATION ${MIGRATION_OWNER};
        CREATE TABLE supabase_migrations.schema_migrations (
          version text PRIMARY KEY,
          statements text[]
        );
        ALTER TABLE supabase_migrations.schema_migrations OWNER TO ${MIGRATION_OWNER};
        INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20261104000001');
      `);
      await runScript(db);
      expect(
        await queryAs(
          db,
          BACKUP_ROLE,
          `SELECT version FROM supabase_migrations.schema_migrations`,
        ),
      ).toEqual([{ version: "20261104000001" }]);
    } finally {
      await db.close();
    }
  });
});

describe("what a recovery runs", () => {
  it.each([
    ["the job", read("scripts", "test-backup-restore.sh")],
    ["the guide", read("docs", "BACKUPS.md")],
  ])(
    "%s runs the grant script and reruns no migration for it",
    (_name, text) => {
      expect(text).toContain("backup/grant-backup-role.psql");
      expect(text).not.toMatch(
        /-f supabase\/migrations\/[0-9]+_backup_role\.sql/u,
      );
    },
  );

  it("the job works out its expected counts from the catalog", () => {
    const script = read("scripts", "test-backup-restore.sh");
    expect(script).not.toMatch(/expected_policies=[1-9]/u);
    expect(script).not.toMatch(
      /-ge [1-9][0-9]* *\]\] *\|\| die "the manifest/u,
    );
  });
});
