import { describe, expect, it } from "vitest";
import { createTask, editTask, getTask } from "../../src/db/tasks.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
} from "../db/fixtures.ts";
import { fakeId, present } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

const FEATURE_NOT_SUPPORTED = "0A000";

/**
 * The task quotas, raced at their limit. They are there to stop an officer account, stolen
 * or careless, from flooding a server, and someone doing that on purpose would send writes
 * at the same moment to get past a count. Two writes for the last place must take turns,
 * and only one may get it.
 */
describe("two writes for the last place under a quota", () => {
  const db = raceDatabase();
  const insertBySql = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                       VALUES ($1, $2, $3, 'Book the room', '${FIXTURE_DUE_DATE}', $4) RETURNING id`;
  // edit_task with the task's own text and date and a new person, which counts as a
  // reassignment by the actor.
  const reassignSql = `SELECT public.edit_task(task.id, task.guild_id, task.updated_at,
                         task.description, task.due_date, $2, $3) AS task
                       FROM public.tasks AS task WHERE task.id = $1`;

  async function countOf(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await db.observer.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? -1;
  }

  /** New tasks and reassignments by one officer, the two things the daily quota counts. */
  async function officerActions(
    guildId: string,
    officer: string,
  ): Promise<number> {
    return countOf(
      `SELECT (SELECT count(*) FROM public.tasks WHERE guild_id = $1 AND created_by = $2)::int
            + (SELECT count(*) FROM public.task_reassignments WHERE guild_id = $1 AND actor_id = $2)::int AS n`,
      [guildId, officer],
    );
  }

  const newTask = (guildId: string, eventId: string, actorId: string) => ({
    guildId,
    eventId,
    assigneeId: fakeId(),
    actorId,
    description: "Book the room",
    dueDate: FIXTURE_DUE_DATE as DateOnly,
  });

  it("an officer's last new task of the day goes to one of two, in different events", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    // A second event, so the event's own lock does not make the two take turns and only
    // the officer's lock can.
    const otherEvent = await insertEvent(db.connection, guild);
    const officer = fakeId();
    for (let index = 0; index < 49; index += 1) {
      await db.observer.query(insertBySql, [
        eventId,
        guild.guildId,
        fakeId(),
        officer,
      ]);
    }

    const second = await db.race(
      [insertBySql, [eventId, guild.guildId, fakeId(), officer]],
      (bot) => createTask(bot, newTask(guild.guildId, otherEvent, officer)),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "actor_task_limit", code: "CF430" },
    });
    expect(await officerActions(guild.guildId, officer)).toBe(50);
  });

  it("an event's last free place goes to one of two tasks", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    // Each by a different officer, so only the event's limit is reached.
    for (let index = 0; index < 99; index += 1) {
      await insertTask(db.connection, guild, eventId);
    }

    const second = await db.race(
      [insertBySql, [eventId, guild.guildId, fakeId(), fakeId()]],
      (bot) => createTask(bot, newTask(guild.guildId, eventId, fakeId())),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "event_task_limit", code: "CF429" },
    });
    expect(
      await countOf(
        "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
        [eventId],
      ),
    ).toBe(100);
  });

  it("an officer's last reassignment of the day goes to one of two", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const officer = fakeId();
    const created: string[] = [];
    for (let index = 0; index < 49; index += 1) {
      const { rows } = await db.observer.query<{ id: string }>(insertBySql, [
        eventId,
        guild.guildId,
        fakeId(),
        officer,
      ]);
      created.push(present(rows[0]?.id));
    }
    // Two different tasks, so the task's own row lock does not make the two take turns
    // and only the officer's lock can.
    const [first, other] = [present(created[0]), present(created[1])];
    const read = await getTask(db.db, {
      guildId: guild.guildId,
      taskId: other,
    });
    if (!read.ok || read.value === null) {
      throw new Error("expected the task to be readable");
    }
    const task = read.value;

    const second = await db.race(
      [reassignSql, [first, fakeId(), officer]],
      (bot) =>
        editTask(bot, {
          guildId: guild.guildId,
          taskId: other,
          expectedUpdatedAt: task.updated_at,
          description: task.description,
          dueDate: task.due_date,
          assigneeId: fakeId(),
          actorId: officer,
        }),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "actor_task_limit", code: "CF430" },
    });
    expect(await officerActions(guild.guildId, officer)).toBe(50);
  });

  it("a write at a higher isolation level is refused, as its count could miss the other's", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);

    await db.t1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(
      db.t1.query(insertBySql, [eventId, guild.guildId, fakeId(), fakeId()]),
    ).rejects.toMatchObject({ code: FEATURE_NOT_SUPPORTED });
    await db.t1.query("ROLLBACK");

    await db.t1.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    await expect(
      db.t1.query(reassignSql, [taskId, fakeId(), fakeId()]),
    ).rejects.toMatchObject({ code: FEATURE_NOT_SUPPORTED });
    await db.t1.query("ROLLBACK");
  });
});
