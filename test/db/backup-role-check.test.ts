import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertEvent, insertGuild, insertTask } from "./fixtures.ts";
import { BACKUP_ROLE, createMigratedDb, queryAs } from "./harness.ts";

const TABLE_COUNT = 10;

/** The role check that backup/run-backup.sh really runs, so this tests that text. */
function roleCheckSql(): string {
  const script = readFileSync(
    join(import.meta.dirname, "..", "..", "backup", "run-backup.sh"),
    "utf8",
  );
  const sql = /run_sql <<'SQL'\n([\s\S]*?)\nSQL\n/.exec(script)?.[1];
  if (sql === undefined) {
    throw new Error("cannot find the role check in run-backup.sh");
  }
  return sql;
}

interface RoleCheck {
  rolname: string;
  elevated: boolean;
  memberships: number;
  writable: number;
  unreadable: number;
  hidden: number;
  tables: number;
}

describe("the backup job's role check, on the policy path", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await createMigratedDb();
    const guild = await insertGuild(db);
    const eventId = await insertEvent(db, guild);
    await insertTask(db, guild, eventId);
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs the check after a policy change, then undoes the change. */
  async function checkAfter(change: string): Promise<RoleCheck> {
    await db.exec(`BEGIN; ${change}`);
    try {
      const rows = await queryAs<RoleCheck>(db, BACKUP_ROLE, roleCheckSql());
      if (rows[0] === undefined) {
        throw new Error("the role check returned no row");
      }
      return rows[0];
    } finally {
      await db.exec("ROLLBACK");
    }
  }

  const SWAP = `DROP POLICY backup_ro_read ON public.tasks;`;

  it("passes the migration's own policies", async () => {
    const check = await checkAfter("");
    expect(check).toMatchObject({
      rolname: BACKUP_ROLE,
      elevated: false,
      memberships: 0,
      writable: 0,
      unreadable: 0,
      hidden: 0,
    });
    expect(check.tables).toBe(TABLE_COUNT);
  });

  it("counts a table as hidden under USING (false), and that hides real rows", async () => {
    await db.exec(
      `BEGIN; ALTER POLICY backup_ro_read ON public.tasks USING (false);`,
    );
    try {
      const [check] = await queryAs<RoleCheck>(db, BACKUP_ROLE, roleCheckSql());
      expect(check?.hidden).toBe(1);
      // The proof that a live count cannot catch this: it sees the same nothing.
      const visible = await queryAs<{ count: number }>(
        db,
        BACKUP_ROLE,
        `SELECT count(*)::int AS count FROM public.tasks`,
      );
      expect(visible[0]?.count).toBe(0);
      const real = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.tasks`,
      );
      expect(real.rows[0]?.count).toBeGreaterThan(0);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it.each([
    ["no policy", SWAP],
    [
      "a partial condition",
      `ALTER POLICY backup_ro_read ON public.tasks USING (status = 'open');`,
    ],
    [
      "a policy for another role only",
      `${SWAP} CREATE POLICY other ON public.tasks FOR SELECT TO anon USING (true);`,
    ],
    [
      "a policy for writes only",
      `${SWAP} CREATE POLICY other ON public.tasks FOR UPDATE TO backup_ro USING (true);`,
    ],
    [
      "a restrictive policy on the role",
      `CREATE POLICY other ON public.tasks AS RESTRICTIVE FOR SELECT TO backup_ro USING (status = 'open');`,
    ],
    [
      "a restrictive policy on PUBLIC",
      `CREATE POLICY other ON public.tasks AS RESTRICTIVE FOR ALL TO PUBLIC USING (true);`,
    ],
    [
      "only a restrictive USING (true)",
      `${SWAP} CREATE POLICY other ON public.tasks AS RESTRICTIVE FOR SELECT TO backup_ro USING (true);`,
    ],
  ])("counts a table as hidden with %s", async (_name, change) => {
    expect((await checkAfter(change)).hidden).toBe(1);
  });

  it.each([
    [
      "a permissive USING (true) for PUBLIC",
      `${SWAP} CREATE POLICY other ON public.tasks FOR SELECT TO PUBLIC USING (true);`,
    ],
    [
      "a permissive USING (true) for all commands",
      `${SWAP} CREATE POLICY other ON public.tasks FOR ALL TO backup_ro USING (true);`,
    ],
    [
      "row level security off on the table",
      `${SWAP} ALTER TABLE public.tasks DISABLE ROW LEVEL SECURITY;`,
    ],
  ])("counts a table as visible with %s", async (_name, change) => {
    expect((await checkAfter(change)).hidden).toBe(0);
  });

  it("notices a grant that lets the role change a table", async () => {
    const check = await checkAfter(
      `GRANT UPDATE ON public.tasks TO ${BACKUP_ROLE};`,
    );
    expect(check.writable).toBe(1);
  });

  it("notices a missing grant", async () => {
    const check = await checkAfter(
      `REVOKE SELECT ON public.tasks FROM ${BACKUP_ROLE};`,
    );
    expect(check.unreadable).toBe(1);
  });

  it("notices membership in another role", async () => {
    const check = await checkAfter(`GRANT service_role TO ${BACKUP_ROLE};`);
    expect(check.memberships).toBe(1);
  });
});
