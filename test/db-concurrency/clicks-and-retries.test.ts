import { describe, expect, it } from "bun:test";
import {
  claimStepHandoff,
  completeEventStep,
} from "../../src/db/event-steps.ts";
import {
  closeEvent,
  createEvent,
  softDeleteEvent,
} from "../../src/db/events.ts";
import { claimInteraction } from "../../src/db/interaction-claims.ts";
import {
  createTask,
  editTask,
  getTask,
  markOwnTaskDone,
} from "../../src/db/tasks.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId, queryAs } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/**
 * Clicks, retried deliveries and changes that land on the same row at once, each handled
 * by its own function instance.
 */
const db = raceDatabase();

const NOT_FOUND = {
  ok: false,
  error: { category: "not_found", code: null },
} as const;
const PARENT_UNAVAILABLE = {
  ok: false,
  error: { category: "parent_unavailable", code: "CF410" },
} as const;

/** A guild with one event holding one task, assigned to the given person. */
async function eventWithTask(assignee = fakeId()) {
  const guild = await insertGuild(db.connection);
  const eventId = await insertEvent(db.connection, guild);
  const taskId = await insertTask(db.connection, guild, eventId, assignee);
  return { guildId: guild.guildId, eventId, taskId, assignee };
}

describe("a retried interaction", () => {
  const claimSql = "SELECT public.claim_interaction($1)";

  it.each([
    ["only one of the two deliveries", "COMMIT", false],
    ["the retry if the first delivery's claim rolls back", "ROLLBACK", true],
  ] as const)("is handled by %s", async (_label, finish, handled) => {
    const interactionId = fakeId();
    const second = await db.race(
      [claimSql, [interactionId]],
      (bot) => claimInteraction(bot, { interactionId }),
      finish,
    );
    expect(second).toEqual({ ok: true, value: handled });
  });
});

describe("a double click on Done", () => {
  it("marks a task done once, and the second click finds nothing to change", async () => {
    const { guildId, taskId, assignee } = await eventWithTask();

    const second = await db.race(
      [
        `UPDATE public.tasks SET status = 'done', completed_at = now()
         WHERE id = $1 AND guild_id = $2 AND assignee_id = $3
           AND status = 'open' AND deleted_at IS NULL
         RETURNING id`,
        [taskId, guildId, assignee],
      ],
      (bot) =>
        markOwnTaskDone(bot, {
          guildId,
          taskId,
          assigneeId: assignee,
          now: new Date(),
        }),
    );

    expect(second).toEqual(NOT_FOUND);
    const { rows } = await db.observer.query(
      "SELECT status FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "done" }]);
  });

  it("marks a step done once, and the second click is told it was done already", async () => {
    const { guildId, eventId } = await eventWithTask();

    const second = await db.race(
      [
        "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
        [eventId, guildId, fakeId()],
      ],
      (bot) =>
        completeEventStep(bot, {
          guildId,
          eventId,
          kind: "budget_sheet",
          actorId: fakeId(),
        }),
    );

    expect(second).toEqual({ ok: true, value: false });
  });

  it("hands a finished step off once, so the next role is pinged once", async () => {
    const { guildId, eventId } = await eventWithTask();
    await queryAs(
      db.connection,
      "bot_app",
      "SELECT public.complete_event_step($1, $2, 'budget_sheet', $3)",
      [eventId, guildId, fakeId()],
    );

    const second = await db.race(
      [
        "SELECT public.claim_step_handoff($1, $2, 'budget_sheet')",
        [eventId, guildId],
      ],
      (bot) =>
        claimStepHandoff(bot, { guildId, eventId, kind: "budget_sheet" }),
    );

    expect(second).toEqual({ ok: true, value: false });
    const { rows } = await db.observer.query(
      `SELECT handoff_claimed_at IS NOT NULL AS claimed FROM public.event_steps
       WHERE event_id = $1 AND kind = 'budget_sheet'`,
      [eventId],
    );
    expect(rows).toEqual([{ claimed: true }]);
  });
});

describe("a task change racing another change", () => {
  // edit_task with the task's own date, as an edit through the bot sends it.
  const editSql = `SELECT public.edit_task(task.id, task.guild_id, task.updated_at,
                     $2, task.due_date, $3, $4) AS task
                   FROM public.tasks AS task WHERE task.id = $1`;
  const closeSql =
    "UPDATE public.events SET status = 'closed' WHERE id = $1 RETURNING id";

  it("a Done click waiting on a reassign finds the task no longer the clicker's", async () => {
    const { guildId, taskId, assignee } = await eventWithTask();
    const newAssignee = fakeId();

    const second = await db.race(
      [editSql, [taskId, "Book the room", newAssignee, fakeId()]],
      (bot) =>
        markOwnTaskDone(bot, {
          guildId,
          taskId,
          assigneeId: assignee,
          now: new Date(),
        }),
    );

    expect(second).toEqual(NOT_FOUND);
    const { rows } = await db.observer.query(
      "SELECT status, assignee_id FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ status: "open", assignee_id: newAssignee }]);
  });

  it("a change waiting on the event's close is refused", async () => {
    const { guildId, eventId, taskId } = await eventWithTask();
    const read = await getTask(db.db, { guildId, taskId });
    if (!read.ok || read.value === null) {
      throw new Error("expected the task to be readable");
    }
    const task = read.value;

    const second = await db.race([closeSql, [eventId]], (bot) =>
      editTask(bot, {
        guildId,
        taskId,
        expectedUpdatedAt: task.updated_at,
        description: "New",
        dueDate: task.due_date,
        assigneeId: task.assignee_id,
        actorId: fakeId(),
      }),
    );

    expect(second).toEqual(PARENT_UNAVAILABLE);
    const { rows } = await db.observer.query(
      "SELECT description FROM public.tasks WHERE id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ description: "Book the room" }]);
  });

  it("the event's close waits for a change in progress, then closes", async () => {
    const { guildId, eventId, taskId, assignee } = await eventWithTask();

    const second = await db.race(
      [editSql, [taskId, "New", assignee, fakeId()]],
      (bot) => closeEvent(bot, { guildId, eventId }),
    );

    expect(second).toMatchObject({ ok: true, value: { id: eventId } });
  });
});

describe("a delete racing an insert under it", () => {
  it("an event's soft delete waits for a task being inserted, then deletes it too", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      [
        `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $3)`,
        [eventId, guild.guildId, fakeId()],
      ],
      (bot) => softDeleteEvent(bot, { guildId: guild.guildId, eventId }),
    );

    expect(second).toEqual({ ok: true, value: 1 });
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
      [eventId],
    );
    expect(rows).toEqual([{ n: 0 }]);
  });

  it("a task insert waits for its event's soft delete, then is refused", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);

    const second = await db.race(
      ["SELECT public.soft_delete_event($1, $2)", [eventId, guild.guildId]],
      (bot) =>
        createTask(bot, {
          guildId: guild.guildId,
          eventId,
          assigneeId: fakeId(),
          actorId: fakeId(),
          description: "Book the room",
          dueDate: "2030-01-10" as DateOnly,
        }),
    );

    expect(second).toEqual(PARENT_UNAVAILABLE);
  });

  it("an event insert waits for its channel's removal, then is refused", async () => {
    const guild = await insertGuild(db.connection);

    const second = await db.race(
      [
        "SELECT public.apply_config_change($1, 2, $2, NULL, NULL, ARRAY[$3]::text[])",
        [guild.guildId, fakeId(), guild.channelId],
      ],
      (bot) =>
        createEvent(bot, {
          guildId: guild.guildId,
          channelId: guild.channelId,
          actorId: fakeId(),
          name: "Social",
          eventDate: "2030-02-01" as DateOnly,
        }),
    );

    expect(second).toEqual(PARENT_UNAVAILABLE);
  });
});
