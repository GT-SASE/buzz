import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  BOT_APP,
  OTHER_ROLE,
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

  it("records the old event row when bot_app updates it, and not the insert", async () => {
    const eventId = await insertEvent(db, guild);
    await queryAs(
      db,
      "bot_app",
      `UPDATE public.events SET name = 'Renamed' WHERE id = $1`,
      [eventId],
    );

    const versions = await versionsOf(eventId);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.source_table).toBe("events");
    expect(versions[0]?.operation).toBe("UPDATE");
    expect(versions[0]?.old_row.name).toBe("General meeting");
  });

  it("keeps one version per update, in order", async () => {
    const taskId = await insertTask(db, guild, await insertEvent(db, guild));
    for (const description of ["Second", "Third"]) {
      await queryAs(
        db,
        MIGRATION_OWNER,
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
      "bot_app",
      `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
      [taskId],
    );
    const versions = await versionsOf(taskId);
    expect(versions[0]?.old_row.deleted_at).toBeNull();
  });

  it.each([
    ["task", "tasks", "status = status"],
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
        "bot_app",
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

  describe.each([BOT_APP, OTHER_ROLE])("as %s", (role) => {
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
