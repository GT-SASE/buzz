/**
 * The SQL that docs/BACKUPS.md gives a maintainer to run by hand. These read each statement
 * from the guide and run it as the tables' owner, so the guide cannot drift from what works.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  MIGRATION_OWNER,
  createBootstrappedDb,
  createMigratedDb,
  errorCodeOf,
  fakeId,
  migrationScripts,
  queryAs,
} from "./harness.ts";

const GUIDE = readFileSync(
  join(import.meta.dirname, "..", "..", "docs", "BACKUPS.md"),
  "utf8",
);

/** The statement under a `-- <name>` line in the guide, ending at the first line's `;`. */
function guideSql(name: string): string {
  const lines = GUIDE.split("\n");
  const start = lines.indexOf(`-- ${name}`);
  if (start === -1) {
    throw new Error(`the guide has no statement named ${name}`);
  }
  const end = lines.findIndex((line, i) => i > start && line.endsWith(";"));
  return lines.slice(start + 1, end + 1).join("\n");
}

function fill(sql: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`<${key}>`, value),
    sql,
  );
}

describe("undoing a change", () => {
  let db: PGlite;
  let guild: GuildFixture;
  let eventId: string;
  let taskId: string;

  /** Runs a named statement from the guide as the owner, and returns its rows. */
  function run(
    name: string,
    values: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    return queryAs(db, MIGRATION_OWNER, fill(guideSql(name), values));
  }

  async function eventRow(id: string) {
    const { rows } = await db.query<{
      status: string;
      deleted_at: unknown;
      thread_id: string | null;
      thread_status: string;
      overview_message_id: string | null;
    }>(
      `SELECT status, deleted_at, thread_id, thread_status, overview_message_id
       FROM public.events WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function taskRow(id: string) {
    const { rows } = await db.query<{
      status: string;
      completed_at: unknown;
      deleted_at: unknown;
      assignee_id: string;
      description: string;
    }>(
      `SELECT status, completed_at, deleted_at, assignee_id, description
       FROM public.tasks WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  function closeEvent(): Promise<unknown> {
    return queryAs(
      db,
      "service_role",
      `UPDATE public.events SET status = 'closed' WHERE id = $1`,
      [eventId],
    );
  }

  function markDone(id: string): Promise<unknown> {
    return queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [id],
    );
  }

  function softDeleteEvent(id: string): Promise<unknown> {
    return queryAs(
      db,
      "service_role",
      `SELECT public.soft_delete_event($1, $2)`,
      [id, guild.guildId],
    );
  }

  function linkPost(id: string, threadId: string): Promise<unknown> {
    return queryAs(
      db,
      "service_role",
      `UPDATE public.events SET thread_id = $1, thread_status = 'active', overview_message_id = $2
       WHERE id = $3`,
      [threadId, fakeId(), id],
    );
  }

  beforeEach(async () => {
    db = await createMigratedDb();
    guild = await insertGuild(db);
    eventId = await insertEvent(db, guild);
    taskId = await insertTask(db, guild, eventId);
  });

  afterEach(async () => {
    await db.close();
  });

  it("reopens a closed event", async () => {
    await closeEvent();
    await run("undo: reopen event", { "event id": eventId });
    expect((await eventRow(eventId))?.status).toBe("active");
  });

  it("reopens a done task, only after its closed event is reopened", async () => {
    await markDone(taskId);
    await closeEvent();
    expect(
      await errorCodeOf(run("undo: reopen task", { "task id": taskId })),
    ).toBe("CF410");

    await run("undo: reopen event", { "event id": eventId });
    await run("undo: reopen task", { "task id": taskId });
    expect(await taskRow(taskId)).toMatchObject({
      status: "open",
      completed_at: null,
    });
  });

  it("undeletes an event with the tasks deleted alongside it, and no others", async () => {
    const deletedEarlier = await insertTask(db, guild, eventId);
    await queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET deleted_at = now() - interval '1 minute' WHERE id = $1`,
      [deletedEarlier],
    );
    await softDeleteEvent(eventId);
    expect((await taskRow(taskId))?.deleted_at).not.toBeNull();

    await run("undo: undelete event", { "event id": eventId });

    expect((await eventRow(eventId))?.deleted_at).toBeNull();
    expect((await taskRow(taskId))?.deleted_at).toBeNull();
    expect((await taskRow(deletedEarlier))?.deleted_at).not.toBeNull();
  });

  it("fails with 23505 once the post has a new event, and can undelete without the post", async () => {
    const threadId = fakeId();
    await linkPost(eventId, threadId);
    await softDeleteEvent(eventId);
    const newer = await insertEvent(db, guild);
    await linkPost(newer, threadId);

    expect(
      await errorCodeOf(run("undo: undelete event", { "event id": eventId })),
    ).toBe("23505");
    expect((await eventRow(eventId))?.deleted_at).not.toBeNull();
    expect((await taskRow(taskId))?.deleted_at).not.toBeNull();

    const holders = await run("undo: find post holder", {
      "event id": eventId,
    });
    expect(holders.map((row) => row.id)).toEqual([newer]);

    await run("undo: undelete event without its post", {
      "event id": eventId,
    });
    expect(await eventRow(eventId)).toMatchObject({
      deleted_at: null,
      thread_id: null,
      thread_status: "pending",
      overview_message_id: null,
    });
    expect((await taskRow(taskId))?.deleted_at).toBeNull();
    expect((await eventRow(newer))?.thread_id).toBe(threadId);

    // What /event link then does to it, through the bot's own role.
    await linkPost(eventId, fakeId());
    expect((await eventRow(eventId))?.thread_status).toBe("active");
  });

  it("undeletes one task", async () => {
    await queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET deleted_at = now() WHERE id = $1`,
      [taskId],
    );
    await run("undo: undelete task", { "task id": taskId });
    expect((await taskRow(taskId))?.deleted_at).toBeNull();
  });

  it("puts back an earlier version of a task from history", async () => {
    const before = await taskRow(taskId);
    await queryAs(
      db,
      "service_role",
      `UPDATE public.tasks SET assignee_id = $1, description = 'Overwritten' WHERE id = $2`,
      [fakeId(), taskId],
    );

    const versions = await run("undo: list task versions", {
      "task id": taskId,
    });
    expect(versions).toHaveLength(1);
    const versionId = String(versions[0]?.id);

    await run("undo: restore task version", { "version id": versionId });
    const after = await taskRow(taskId);
    expect(after?.assignee_id).toBe(before?.assignee_id);
    expect(after?.description).toBe(before?.description);
  });

  it("keeps a record of each undo in history", async () => {
    await closeEvent();
    await run("undo: reopen event", { "event id": eventId });
    const { rows } = await db.query(
      `SELECT count(*)::int AS versions FROM history.row_versions
       WHERE source_table = 'events' AND row_id = $1`,
      [eventId],
    );
    expect(rows).toEqual([{ versions: 2 }]);
  });
});

describe("the schema check", () => {
  const SCHEMA_CHECK = guideSql("schema check");

  async function fingerprint(db: PGlite): Promise<unknown[]> {
    return (await db.query(SCHEMA_CHECK)).rows;
  }

  it("matches between two projects with the same migrations", async () => {
    const [one, two] = await Promise.all([
      createMigratedDb(),
      createMigratedDb(),
    ]);
    try {
      const result = await fingerprint(one);
      expect(result.length).toBeGreaterThan(0);
      expect(await fingerprint(two)).toEqual(result);
    } finally {
      await Promise.all([one.close(), two.close()]);
    }
  });

  it("notices a dropped trigger", async () => {
    const db = await createMigratedDb();
    try {
      const before = await fingerprint(db);
      await db.exec(
        `DROP TRIGGER tasks_require_open_parent_on_update ON public.tasks`,
      );
      expect(await fingerprint(db)).not.toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("notices a dropped constraint and a changed function", async () => {
    const db = await createMigratedDb();
    try {
      const before = await fingerprint(db);
      await db.exec(
        `ALTER TABLE public.tasks DROP CONSTRAINT tasks_completed_matches_status`,
      );
      const withoutConstraint = await fingerprint(db);
      expect(withoutConstraint).not.toEqual(before);
      await db.exec(
        `CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
           LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
      );
      expect(await fingerprint(db)).not.toEqual(withoutConstraint);
    } finally {
      await db.close();
    }
  });

  it("notices a dropped index that backs no constraint", async () => {
    const db = await createMigratedDb();
    try {
      const before = await fingerprint(db);
      await db.exec(`DROP INDEX public.events_live_thread_uq`);
      expect(await fingerprint(db)).not.toEqual(before);
    } finally {
      await db.close();
    }
  });

  it("notices a migration recorded as applied that never ran", async () => {
    const full = await createMigratedDb();
    const missing = await createBootstrappedDb();
    try {
      const scripts = migrationScripts();
      const withGuard = scripts.findIndex((script) =>
        script.includes("tasks_require_open_parent_on_update"),
      );
      for (const [index, script] of scripts.entries()) {
        if (index !== withGuard) {
          await missing.exec(script);
        }
      }
      expect(await fingerprint(missing)).not.toEqual(await fingerprint(full));
    } finally {
      await Promise.all([full.close(), missing.close()]);
    }
  });
});

describe("what the guide says about the policies path", () => {
  it("gives the number of policies this path really creates", async () => {
    const db = await createMigratedDb();
    try {
      const { rows } = await db.query<{ policies: number }>(
        `SELECT count(*)::int AS policies FROM pg_policies WHERE policyname = 'backup_ro_read'`,
      );
      const policies = rows[0]?.policies;
      expect(policies).toBeGreaterThan(0);
      expect(GUIDE).toContain(`returns ${String(policies)}, one per table`);
    } finally {
      await db.close();
    }
  });
});
