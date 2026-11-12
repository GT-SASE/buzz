import { describe, expect, it } from "vitest";
import { closeEvent } from "../../src/db/events.ts";
import { editTask, getTask, markOwnTaskDone } from "../../src/db/tasks.ts";
import type { TaskRow } from "../../src/db/types.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/** A task being changed while something else changes it, or closes its event. */
describe("a task change racing another change", () => {
  const db = raceDatabase();
  // edit_task with the task's own date, as an edit through the bot sends it.
  const editSql = `SELECT public.edit_task(task.id, task.guild_id, task.updated_at,
                     $2, task.due_date, $3, $4) AS task
                   FROM public.tasks AS task WHERE task.id = $1`;

  async function readTask(guildId: string, taskId: string): Promise<TaskRow> {
    const read = await getTask(db.db, { guildId, taskId });
    if (!read.ok || read.value === null) {
      throw new Error("expected the task to be readable");
    }
    return read.value;
  }

  it("a Done click waiting on a reassign finds the task no longer the clicker's", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const assignee = fakeId();
    const taskId = await insertTask(db.connection, guild, eventId, assignee);
    const newAssignee = fakeId();

    const second = await db.race(
      [editSql, [taskId, "Book the room", newAssignee, fakeId()]],
      (bot) =>
        markOwnTaskDone(bot, {
          guildId: guild.guildId,
          taskId,
          assigneeId: assignee,
          now: new Date(),
        }),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
    const { rows } = await db.observer.query(
      "SELECT status, assignee_id FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "open", assignee_id: newAssignee }]);
  });

  describe("against the event being closed", () => {
    const closeSql =
      "UPDATE public.events SET status = 'closed' WHERE id = $1 RETURNING id";

    it("a change waiting on the close is refused", async () => {
      const guild = await insertGuild(db.connection);
      const eventId = await insertEvent(db.connection, guild);
      const taskId = await insertTask(db.connection, guild, eventId);
      const task = await readTask(guild.guildId, taskId);

      const second = await db.race([closeSql, [eventId]], (bot) =>
        editTask(bot, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: task.updated_at,
          description: "New",
          dueDate: task.due_date,
          assigneeId: task.assignee_id,
          actorId: fakeId(),
        }),
      );

      expect(second).toEqual({
        ok: false,
        error: { category: "parent_unavailable", code: "CF410" },
      });
      const { rows } = await db.observer.query(
        "SELECT description FROM public.tasks WHERE id = $1",
        [taskId],
      );
      expect(rows).toEqual([{ description: "Book the room" }]);
    });

    it("a close waits for a change in progress, then closes", async () => {
      const guild = await insertGuild(db.connection);
      const eventId = await insertEvent(db.connection, guild);
      const assignee = fakeId();
      const taskId = await insertTask(db.connection, guild, eventId, assignee);

      const second = await db.race(
        [editSql, [taskId, "New", assignee, fakeId()]],
        (bot) => closeEvent(bot, { guildId: guild.guildId, eventId }),
      );

      expect(second).toMatchObject({ ok: true, value: { id: eventId } });
    });
  });
});
