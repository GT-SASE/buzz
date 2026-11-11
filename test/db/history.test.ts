import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  API_ROLES,
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  createMigratedDb,
  errorCodeOf,
  queryAs,
} from "./harness.ts";

interface RowVersion {
  source_table: string;
  operation: string;
  row_id: string;
  old_row: Record<string, unknown>;
}

describe("row history", () => {
  let db: PGlite;
  let guild: GuildFixture;

  beforeAll(async () => {
    db = await createMigratedDb();
    guild = await insertGuild(db);
  });

  afterAll(async () => {
    await db.close();
  });

  async function versionsOf(rowId: string): Promise<RowVersion[]> {
    const { rows } = await db.query<RowVersion>(
      `SELECT source_table, operation, row_id, old_row FROM history.row_versions WHERE row_id = $1 ORDER BY id`,
      [rowId],
    );
    return rows;
  }

  it("records the old event row when service_role updates it", async () => {
    const eventId = await insertEvent(db, guild);
    await queryAs(
      db,
      "service_role",
      `UPDATE public.events SET name = 'Renamed' WHERE id = $1`,
      [eventId],
    );

    const versions = await versionsOf(eventId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source_table).toBe("events");
    expect(versions[0]?.operation).toBe("UPDATE");
    expect(versions[0]?.old_row.name).toBe("General meeting");
  });

  it("records the old task row when service_role updates it", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    await queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET description = 'Changed' WHERE id = $1`,
      [taskId],
    );

    const versions = await versionsOf(taskId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source_table).toBe("tasks");
    expect(versions[0]?.old_row.description).toBe("Book the room");
  });

  it("keeps one version per update, in order", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    for (const description of ["Second", "Third"]) {
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET description = $2 WHERE id = $1`,
        [taskId, description],
      );
    }
    const versions = await versionsOf(taskId);
    expect(versions.map((version) => version.old_row.description)).toEqual([
      "Book the room",
      "Second",
    ]);
  });

  it("records a soft delete, so the row before it can be restored", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    await queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
      [taskId],
    );
    const versions = await versionsOf(taskId);
    expect(versions[0]?.old_row.deleted_at).toBeNull();
  });

  it("records the old row when the owning role hard-deletes a task", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    await queryAs(
      db,
      MIGRATION_OWNER,
      `DELETE FROM public.tasks WHERE id = $1`,
      [taskId],
    );

    const versions = await versionsOf(taskId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.operation).toBe("DELETE");
    expect(versions[0]?.old_row.description).toBe("Book the room");
  });

  it("records the old row when the owning role hard-deletes an event", async () => {
    const eventId = await insertEvent(db, guild);
    await queryAs(
      db,
      MIGRATION_OWNER,
      `DELETE FROM public.events WHERE id = $1`,
      [eventId],
    );

    const versions = await versionsOf(eventId);
    expect(versions[0]?.operation).toBe("DELETE");
    expect(versions[0]?.source_table).toBe("events");
  });

  it.each(["tasks", "events"])(
    "stops even the owning role truncating %s, and keeps the rows",
    async (table) => {
      const taskId = await insertTask(db, guild, await insertEvent(db, guild));
      const code = await errorCodeOf(
        queryAs(db, MIGRATION_OWNER, `TRUNCATE public.${table} CASCADE`),
      );
      expect(code).toBe("CF405");
      const { rows } = await db.query(
        `SELECT id FROM public.tasks WHERE id = $1`,
        [taskId],
      );
      expect(rows).toHaveLength(1);
    },
  );

  it.each([
    ["task", "tasks", "description = description"],
    ["event", "events", "name = name"],
  ])(
    "records nothing for a %s update that changes nothing",
    async (_name, table, set) => {
      const eventId = await insertEvent(db, guild);
      const id =
        table === "tasks" ? await insertTask(db, guild, eventId) : eventId;
      const before = await db.query(
        `SELECT updated_at FROM public.${table} WHERE id = $1`,
        [id],
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      await queryAs(
        db,
        "service_role",
        `UPDATE public.${table} SET ${set} WHERE id = $1`,
        [id],
      );

      expect(await versionsOf(id)).toEqual([]);
      const after = await db.query(
        `SELECT updated_at FROM public.${table} WHERE id = $1`,
        [id],
      );
      expect(after.rows).toEqual(before.rows);
    },
  );

  it("records a value set back to what it was as two versions", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    for (const description of ["Changed", "Book the room"]) {
      await queryAs(
        db,
        "service_role",
        `UPDATE public.tasks SET description = $2 WHERE id = $1`,
        [taskId, description],
      );
    }
    expect(await versionsOf(taskId)).toHaveLength(2);
  });

  it("does not record inserts", async () => {
    const eventId = await insertEvent(db, guild);
    expect(await versionsOf(eventId)).toEqual([]);
  });

  it("the trigger function is SECURITY DEFINER with an empty search_path", async () => {
    const { rows } = await db.query(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'record_row_version'`,
    );
    expect(rows).toEqual([{ prosecdef: true, proconfig: ['search_path=""'] }]);
  });

  describe.each(API_ROLES)("as %s", (role) => {
    it("has no privilege on the schema, table or function", async () => {
      const { rows } = await db.query(
        `SELECT
           has_schema_privilege($1, 'history', 'USAGE') AS schema_usage,
           has_schema_privilege($1, 'history', 'CREATE') AS schema_create,
           has_table_privilege($1, 'history.row_versions', 'SELECT') AS table_select,
           has_table_privilege($1, 'history.row_versions', 'INSERT') AS table_insert,
           has_function_privilege($1, 'history.record_row_version()', 'EXECUTE') AS fn_execute`,
        [role],
      );
      expect(rows).toEqual([
        {
          schema_usage: false,
          schema_create: false,
          table_select: false,
          table_insert: false,
          fn_execute: false,
        },
      ]);
    });

    it.each([
      ["read", `SELECT * FROM history.row_versions`],
      [
        "write",
        `INSERT INTO history.row_versions (source_table, row_id, old_row) VALUES ('x', 'x', '{}')`,
      ],
      ["erase", `DELETE FROM history.row_versions`],
      ["truncate", `TRUNCATE history.row_versions`],
      ["drop the trigger", `DROP TRIGGER tasks_record_update ON public.tasks`],
    ])("cannot %s", async (_action, sql) => {
      expect(await errorCodeOf(queryAs(db, role, sql))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });
});
