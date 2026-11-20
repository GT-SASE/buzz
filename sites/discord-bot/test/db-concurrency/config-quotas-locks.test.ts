import pg from "pg";
import { describe, expect, it } from "bun:test";
import {
  applyConfigChange,
  applyRoleBindings,
  type RoleBindings,
} from "../../src/db/guild-config.ts";
import {
  createTask,
  editTask,
  getTask,
  markTaskDoneAsOfficer,
} from "../../src/db/tasks.ts";
import type { DateOnly } from "../../src/lib/dates.ts";
import {
  FIXTURE_DUE_DATE,
  insertEvent,
  insertGuild,
  insertTask,
} from "../db/fixtures.ts";
import { errorCodeOf, fakeId, present } from "../db/harness.ts";
import { botUrlForDatabase, concurrencyContext } from "./global-setup.ts";
import { raceDatabase, settled } from "./race.ts";

const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_PASSWORD = "28P01";
const FEATURE_NOT_SUPPORTED = "0A000";
const ROUNDS = 25;
const STALE = {
  ok: false,
  error: { category: "stale_version", code: "CF409" },
} as const;

const db = raceDatabase();

/**
 * The role the bot logs in as, on a real server with password logins, reached the way
 * production reaches it. PGlite has one session and no logins, so only this shows what
 * bot_app itself may do once connected, and that it cannot turn into another role.
 */
describe("the bot's role over a real connection", () => {
  it("is logged in as bot_app, with its own statement timeout and UTC", async () => {
    const { rows } = await db.t1.query<{
      user: string;
      timeout: string;
      zone: string;
    }>(
      "SELECT current_user AS user, current_setting('statement_timeout') AS timeout, current_setting('TimeZone') AS zone",
    );
    expect(rows).toEqual([{ user: "bot_app", timeout: "10s", zone: "UTC" }]);
  });

  it.each([
    "DELETE FROM public.tasks",
    "DELETE FROM public.interaction_claims",
    "TRUNCATE public.tasks",
    "TRUNCATE public.config_audit",
    "ALTER TABLE public.tasks DISABLE TRIGGER ALL",
    "CREATE TABLE public.forged (id int)",
    "SELECT * FROM history.row_versions",
    "INSERT INTO public.task_reassignments (guild_id, actor_id, task_id) VALUES ('1', '1', gen_random_uuid())",
    "SET ROLE migration_owner",
  ])("cannot run %s", async (sql) => {
    expect(await errorCodeOf(db.t1.query(sql))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("is refused with a wrong password", async () => {
    const { adminUrl, botPassword } = concurrencyContext();
    const url = new URL(botUrlForDatabase(adminUrl, "postgres", botPassword));
    url.password = `${url.password}-wrong`;
    const client = new pg.Client({ connectionString: url.toString() });
    expect(await errorCodeOf(client.connect())).toBe(INVALID_PASSWORD);
    await client.end().catch(() => undefined);
  });
});

/**
 * Two panels saving at once, or two first setups of the same server. Each save names the
 * version it read, and the one that loses must be told its view is stale rather than
 * overwrite the other.
 */
describe("two config saves at once", () => {
  const changeSql =
    "SELECT public.apply_config_change($1, $2, $3, $4) AS version";
  const bindingsSql =
    "SELECT public.apply_role_bindings($1, $2, $3, $4, $5, $6, $7, $8, $9) AS version";

  /** Arguments after the version for a full set of role bindings: actor, then roles. */
  const roles = () => Array.from({ length: 7 }, () => fakeId());

  /** The bot's own save of a full set of role bindings. */
  const bindings = (
    guildId: string,
    expectedVersion: number,
  ): RoleBindings => ({
    guildId,
    actorId: fakeId(),
    expectedVersion,
    officerRoleId: fakeId(),
    adminRoleId: fakeId(),
    eboardRoleId: fakeId(),
    eventsCommitteeRoleId: fakeId(),
    treasuryRoleId: fakeId(),
    marketingRoleId: fakeId(),
  });

  const remindersOn = (guildId: string) => ({
    guildId,
    actorId: fakeId(),
    expectedVersion: 2,
    remindersEnabled: true,
    addChannelIds: [],
    removeChannelIds: [],
    timezone: null,
  });

  async function auditCount(guildId: string): Promise<number> {
    const { rows } = await db.observer.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.config_audit WHERE guild_id = $1",
      [guildId],
    );
    return rows[0]?.n ?? -1;
  }

  it.each([
    ["gets CF409 and changes nothing", "COMMIT", STALE, false],
    [
      "goes through if the first rolls back",
      "ROLLBACK",
      { ok: true, value: 3 },
      true,
    ],
  ] as const)(
    "settings: the save that waited %s",
    async (_label, finish, expected, enabled) => {
      // insertGuild leaves the guild at version 2 with two audit rows.
      const { guildId } = await insertGuild(db.connection);

      const second = await db.race(
        [changeSql, [guildId, 2, fakeId(), false]],
        (bot) => applyConfigChange(bot, remindersOn(guildId)),
        finish,
      );

      expect(second).toEqual(expected);
      const { rows } = await db.observer.query(
        "SELECT version, reminders_enabled FROM public.guild_config WHERE guild_id = $1",
        [guildId],
      );
      expect(rows).toEqual([{ version: 3, reminders_enabled: enabled }]);
      expect(await auditCount(guildId)).toBe(3);
    },
  );

  it("role bindings: the save that waited gets CF409 and changes nothing", async () => {
    const { guildId } = await insertGuild(db.connection);

    const second = await db.race(
      [bindingsSql, [guildId, 2, ...roles()]],
      (bot) => applyRoleBindings(bot, bindings(guildId, 2)),
    );

    expect(second).toEqual(STALE);
    expect(await auditCount(guildId)).toBe(3);
  });

  it.each([
    ["gets CF409", "COMMIT", STALE],
    [
      "goes through if the first rolls back",
      "ROLLBACK",
      { ok: true, value: 1 },
    ],
  ] as const)(
    "first setup: the setup that waited %s, leaving one config row and one audit row",
    async (_label, finish, expected) => {
      const guildId = fakeId();
      const first = roles();
      const saved = bindings(guildId, 0);

      const second = await db.race(
        [bindingsSql, [guildId, 0, ...first]],
        (bot) => applyRoleBindings(bot, saved),
        finish,
      );

      expect(second).toEqual(expected);
      const { rows } = await db.observer.query(
        "SELECT version, officer_role_id FROM public.guild_config WHERE guild_id = $1",
        [guildId],
      );
      // The first setup keeps its roles unless it rolled back.
      const officerRoleId =
        finish === "COMMIT" ? first[1] : saved.officerRoleId;
      expect(rows).toEqual([{ version: 1, officer_role_id: officerRoleId }]);
      expect(await auditCount(guildId)).toBe(1);
    },
  );
});

/**
 * The task quotas, raced at their limit. They are there to stop an officer account, stolen
 * or careless, from flooding a server, and someone doing that on purpose would send writes
 * at the same moment to get past a count. Two writes for the last place must take turns,
 * and only one may get it.
 */
describe("two writes for the last place under a quota", () => {
  const insertBySql = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                       VALUES ($1, $2, $3, 'Book the room', '${FIXTURE_DUE_DATE}', $4) RETURNING id`;
  // edit_task with the task's own text and date and a new person, which counts as a
  // reassignment by the actor.
  const reassignSql = `SELECT public.edit_task(task.id, task.guild_id, task.updated_at,
                         task.description, task.due_date, $2, $3) AS task
                       FROM public.tasks AS task WHERE task.id = $1`;
  const actorLimit = {
    ok: false,
    error: { category: "actor_task_limit", code: "CF430" },
  } as const;

  async function countOf(sql: string, params: unknown[]): Promise<number> {
    const { rows } = await db.observer.query<{ n: number }>(sql, params);
    return rows[0]?.n ?? -1;
  }

  /** New tasks and reassignments by one officer, the two things the daily quota counts. */
  function officerActions(guildId: string, officer: string): Promise<number> {
    return countOf(
      `SELECT (SELECT count(*) FROM public.tasks WHERE guild_id = $1 AND created_by = $2)::int
            + (SELECT count(*) FROM public.task_reassignments WHERE guild_id = $1 AND actor_id = $2)::int AS n`,
      [guildId, officer],
    );
  }

  /** 49 tasks by one officer in the event, one short of their daily quota. */
  async function nearQuota(guildId: string, eventId: string, officer: string) {
    const created: string[] = [];
    for (let index = 0; index < 49; index += 1) {
      const { rows } = await db.observer.query<{ id: string }>(insertBySql, [
        eventId,
        guildId,
        fakeId(),
        officer,
      ]);
      created.push(present(rows[0]?.id));
    }
    return created;
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
    await nearQuota(guild.guildId, eventId, officer);

    const second = await db.race(
      [insertBySql, [eventId, guild.guildId, fakeId(), officer]],
      (bot) => createTask(bot, newTask(guild.guildId, otherEvent, officer)),
    );

    expect(second).toEqual(actorLimit);
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
    const created = await nearQuota(guild.guildId, eventId, officer);
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

    expect(second).toEqual(actorLimit);
    expect(await officerActions(guild.guildId, officer)).toBe(50);
  });

  it("a write at a higher isolation level is refused, as its count could miss the other's", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);

    await db.t1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const insert = db.t1.query(insertBySql, [
      eventId,
      guild.guildId,
      fakeId(),
      fakeId(),
    ]);
    expect(await errorCodeOf(insert)).toBe(FEATURE_NOT_SUPPORTED);
    await db.t1.query("ROLLBACK");

    await db.t1.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    const reassign = db.t1.query(reassignSql, [taskId, fakeId(), fakeId()]);
    expect(await errorCodeOf(reassign)).toBe(FEATURE_NOT_SUPPORTED);
    await db.t1.query("ROLLBACK");
  });
});

/**
 * Lock order between a task update and its event's soft delete. A wrong order shows up
 * as a deadlock or a wait that never ends, not as a wrong answer.
 */
describe("a task update against its event's soft delete", () => {
  const softDeleteSql =
    "SELECT public.soft_delete_event($1, $2) AS deleted_tasks";
  const markDoneSql = `UPDATE public.tasks SET status = 'done', completed_at = now()
                       WHERE id = $1 AND deleted_at IS NULL`;

  async function eventWithTasks(count: number) {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      taskIds.push(await insertTask(db.connection, guild, eventId));
    }
    return { guildId: guild.guildId, eventId, taskIds };
  }

  it("the delete waits on the task without holding the event, so both succeed", async () => {
    const { guildId, eventId, taskIds } = await eventWithTasks(1);
    const taskId = present(taskIds[0]);

    // T1 stands at the point a task update reaches first: the task's row is locked and
    // its guard has not yet asked for the event.
    await db.t1.query("BEGIN");
    await db.t1.query(
      "SELECT id FROM public.tasks WHERE id = $1 FOR NO KEY UPDATE",
      [taskId],
    );
    const deleted = settled(db.t2.query(softDeleteSql, [eventId, guildId]));
    try {
      await db.waitUntilBlocked(db.t2, db.t1);
      // With the event locked first, this statement and the delete would wait on each
      // other.
      await db.t1.query(markDoneSql, [taskId]);
    } finally {
      await db.t1.query("COMMIT");
    }

    expect(await deleted).toEqual({ rows: [{ deleted_tasks: 1 }] });
    const { rows } = await db.observer.query(
      `SELECT t.status, t.deleted_at IS NOT NULL AS task_gone, e.deleted_at IS NOT NULL AS event_gone
       FROM public.tasks t JOIN public.events e ON e.id = t.event_id
       WHERE t.id = $1`,
      [taskId],
    );
    expect(rows).toEqual([
      { status: "done", task_gone: true, event_gone: true },
    ]);
  });

  it("an update that waits on the delete finds the task gone", async () => {
    const { guildId, eventId, taskIds } = await eventWithTasks(1);

    const second = await db.race([softDeleteSql, [eventId, guildId]], (bot) =>
      markTaskDoneAsOfficer(bot, {
        guildId,
        taskId: present(taskIds[0]),
        now: new Date(),
      }),
    );

    expect(second).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it("does not deadlock when fired together", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { guildId, eventId, taskIds } = await eventWithTasks(5);
      const [update, deleted] = await Promise.all([
        settled(db.t1.query(markDoneSql, [taskIds[4]])),
        settled(db.t2.query(softDeleteSql, [eventId, guildId])),
      ]);
      expect(update.code).toBeUndefined();
      expect(deleted.code).toBeUndefined();
    }
  });
});
