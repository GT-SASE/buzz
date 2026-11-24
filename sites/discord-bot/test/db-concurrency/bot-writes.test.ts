import pg from "pg";
import { describe, expect, it } from "bun:test";
import { createDbClient, withDeadline } from "../../src/db/client.ts";
import { transact } from "../../src/db/internal.ts";
import { limitStatements, openOn } from "../../src/db/open.ts";
import { pgOrm } from "../support/sql-client.ts";
import {
  assignEventStep,
  claimEventReminder,
  completeEventStep,
} from "../../src/db/event-steps.ts";
import {
  applyConfigChange,
  applyRoleBindings,
} from "../../src/db/guild-config.ts";
import { claimInteraction } from "../../src/db/interaction-claims.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { sql } from "drizzle-orm";
import {
  beginJobRun,
  finishJobRun,
  type JobName,
} from "../../src/db/job-runs.ts";
import { createTask, editTask, getTask } from "../../src/db/tasks.ts";
import { must } from "../db/bot-writes.ts";
import type { TaskRow } from "../../src/db/types.ts";
import { interactionClaims } from "../../src/db/schema.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId } from "../db/harness.ts";
import { raceDatabase } from "./race.ts";

/**
 * The bot's write code against itself: many instances of the same write, each on its own
 * connection from the bot's pool, sent at the same moment. The database functions that
 * once did these writes took their locks in SQL; here the locks, the version checks and
 * the conflict clauses are in TypeScript, and these tests are what shows they hold.
 */
const db = raceDatabase();
const ATTEMPTS = 8;

const outcomes = (results: { ok: boolean }[]) =>
  results.filter((result) => result.ok).length;

describe("the same write from several instances at once", () => {
  it("a retried interaction is claimed by exactly one of them", async () => {
    const interactionId = fakeId();
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimInteraction(db.db, { interactionId }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value).length).toBe(
      1,
    );
  });

  it("a task reminder is claimed by exactly one of them", async () => {
    const guild = await insertGuild(db.connection);
    const taskId = await insertTask(
      db.connection,
      guild,
      await insertEvent(db.connection, guild),
    );
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimReminder(db.db, {
          taskId,
          kind: "one_day",
          dueDate: "2030-01-10" as DateOnly,
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(
      results.filter((result) => result.ok && result.value !== null).length,
    ).toBe(1);
  });

  it("an event's step reminder is claimed by exactly one of them", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const reminderDate = todayInZone(new Date(), "America/New_York");
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        claimEventReminder(db.db, {
          eventId,
          kind: "daily_steps",
          reminderDate,
        }),
      ),
    );
    expect(
      results.filter((result) => result.ok && result.value !== null).length,
    ).toBe(1);
  });

  it("a step is completed by exactly one of them, and the rest are told it was done", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, () =>
        completeEventStep(db.db, {
          eventId,
          guildId: guild.guildId,
          kind: "budget_sheet",
          actorId: fakeId(),
        }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.value).length).toBe(
      1,
    );
  });

  it("a step takes at most ten people, whoever arrives together", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => {
        const userId = fakeId();
        return assignEventStep(db.db, {
          eventId,
          guildId: guild.guildId,
          kind: "budget_sheet",
          userId,
          actorId: userId,
        });
      }),
    );
    expect(outcomes(results)).toBe(10);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "step_assignee_limit"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.event_step_assignees WHERE event_id = $1 AND removed_at IS NULL",
      [eventId],
    );
    expect(rows).toEqual([{ n: 10 }]);
  });

  it("two saves of the same config version leave one winner and one audit row each for it", async () => {
    // insertGuild leaves the guild at version 2 with two audit rows.
    const guild = await insertGuild(db.connection);
    const save = (remindersEnabled: boolean) =>
      applyConfigChange(db.db, {
        guildId: guild.guildId,
        actorId: fakeId(),
        expectedVersion: 2,
        remindersEnabled,
        addChannelIds: [],
        removeChannelIds: [],
        timezone: null,
      });
    const results = await Promise.all([save(false), save(true), save(false)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "stale_version"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT version FROM discord_bot.guild_config WHERE guild_id = $1",
      [guild.guildId],
    );
    expect(rows).toEqual([{ version: 3 }]);
    const audit = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.config_audit WHERE guild_id = $1",
      [guild.guildId],
    );
    expect(audit.rows).toEqual([{ n: 3 }]);
  });

  it("two first setups of one server leave one config row", async () => {
    const guildId = fakeId();
    const setup = () =>
      applyRoleBindings(db.db, {
        guildId,
        actorId: fakeId(),
        expectedVersion: 0,
        officerRoleId: fakeId(),
        adminRoleId: fakeId(),
        eboardRoleId: null,
        eventsCommitteeRoleId: null,
        treasuryRoleId: null,
        marketingRoleId: null,
      });
    const results = await Promise.all([setup(), setup(), setup()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "stale_version"),
    ).toBe(true);
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM discord_bot.config_audit WHERE guild_id = $1",
      [guildId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

/**
 * A caller that gave up on a write must not leave it running: no COMMIT after the caller
 * was told it failed, and no lock held for the rest of the transaction.
 */
describe("a write that outlives its deadline", () => {
  const LOCK = "hashtextextended('deadline_test', 0)";
  const slowClient = () =>
    withDeadline(
      createDbClient(
        pgOrm(new pg.Pool({ connectionString: db.botUrl })),
        openOn(async (deadlineMs) => {
          const pool = new pg.Pool({ connectionString: db.botUrl, max: 1 });
          const client = await pool.connect();
          const orm = pgOrm(client);
          await limitStatements(orm, deadlineMs);
          return {
            orm,
            close: async () => {
              client.release();
              await pool.end();
            },
            destroy: () => {
              client.release(true);
              void pool.end().catch(() => undefined);
            },
          };
        }),
      ),
      400,
    );
  const claimed = async (interactionId: string) =>
    (
      await db.observer.query(
        "SELECT 1 FROM discord_bot.interaction_claims WHERE interaction_id = $1",
        [interactionId],
      )
    ).rowCount;
  const lockFree = async () =>
    (
      await db.observer.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(${LOCK}) AS ok`,
      )
    ).rows[0]?.ok === true;
  const idleInTransaction = async () =>
    (
      await db.observer.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = 'bot_app' AND state LIKE 'idle in transaction%'",
      )
    ).rows[0]?.n;

  it("a slow statement is cancelled by the server, leaving no row and no lock", async () => {
    const interactionId = fakeId();
    const result = await transact(slowClient(), async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(LOCK)})`);
      await tx.insert(interactionClaims).values({ interactionId });
      await tx.execute(sql`select pg_sleep(3)`);
    });
    expect(result).toMatchObject({
      ok: false,
      error: { category: "unavailable" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await lockFree()).toBe(true);
    await db.observer.query("SELECT pg_advisory_unlock_all()");
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await claimed(interactionId)).toBe(0);
  });

  it("a transaction idle between statements is dropped, so it cannot commit later", async () => {
    const interactionId = fakeId();
    const result = await transact(slowClient(), async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${sql.raw(LOCK)})`);
      await tx.insert(interactionClaims).values({ interactionId });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await tx.execute(sql`select 1`);
    });
    expect(result).toMatchObject({
      ok: false,
      error: { category: "unavailable" },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await lockFree()).toBe(true);
    await db.observer.query("SELECT pg_advisory_unlock_all()");
    expect(await idleInTransaction()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await claimed(interactionId)).toBe(0);
  });
});

describe("the same transaction from several instances at once", () => {
  it("only one of several edits of one task, all at the version they read, lands", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);
    const read = await getTask(db.db, { guildId: guild.guildId, taskId });
    if (!read.ok || read.value === null) throw new Error("task unreadable");
    const task = read.value;
    const results = await Promise.all(
      Array.from({ length: ATTEMPTS }, (_, index) =>
        editTask(db.db, {
          guildId: guild.guildId,
          taskId,
          expectedUpdatedAt: task.updated_at,
          description: `Edit ${String(index)}`,
          dueDate: task.due_date,
          assigneeId: fakeId(),
          actorId: fakeId(),
        }),
      ),
    );
    expect(outcomes(results)).toBe(1);
    expect(
      results
        .filter((result) => !result.ok)
        .every((result) => result.error.category === "not_found"),
    ).toBe(true);
  });

  it("two start and finish pairs of one job never leave two runs open or a success unseen", async () => {
    for (let round = 0; round < 10; round += 1) {
      const jobName = `pair_${fakeId()}` as JobName;
      const start = () =>
        beginJobRun(db.db, {
          jobName,
          staleAfterSeconds: 120,
          slotStart: new Date(Date.now() - 3_600_000),
        });
      const first = await start();
      const id = first.ok ? first.value : null;
      if (id === null) throw new Error("no first run");
      const [finished, again, third] = await Promise.all([
        finishJobRun(db.db, { id, now: new Date(), results: {}, error: null }),
        start(),
        start(),
      ]);
      expect(finished.ok).toBe(true);
      expect(again).toEqual({ ok: true, value: null });
      expect(third).toEqual({ ok: true, value: null });
    }
  });
});

/**
 * The quotas, raced between the bot's own writes: they hold with or without the triggers,
 * because each write takes the quota's locks itself before it counts.
 */
describe("two writes for the last place under a quota, from the bot alone", () => {
  const newTask = (guildId: string, eventId: string, actorId: string) => ({
    guildId,
    eventId,
    assigneeId: fakeId(),
    actorId,
    description: "Book the room",
    dueDate: "2030-01-10" as DateOnly,
  });
  const failed = (results: { ok: boolean }[]) =>
    results.filter((result) => !result.ok);

  it("an officer's last new task of the day goes to one of two, in different events", async () => {
    const guild = await insertGuild(db.connection);
    const first = await insertEvent(db.connection, guild);
    const second = await insertEvent(db.connection, guild);
    const officer = fakeId();
    for (let index = 0; index < 49; index += 1) {
      must(await createTask(db.db, newTask(guild.guildId, first, officer)));
    }
    const results = await Promise.all([
      createTask(db.db, newTask(guild.guildId, first, officer)),
      createTask(db.db, newTask(guild.guildId, second, officer)),
    ]);
    expect(outcomes(results)).toBe(1);
    expect(failed(results)[0]).toMatchObject({
      error: { category: "actor_task_limit", code: "CF430" },
    });
  });

  it("an event's last free place goes to one of two tasks by different officers", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    for (let index = 0; index < 99; index += 1) {
      await insertTask(db.connection, guild, eventId);
    }
    const results = await Promise.all([
      createTask(db.db, newTask(guild.guildId, eventId, fakeId())),
      createTask(db.db, newTask(guild.guildId, eventId, fakeId())),
    ]);
    expect(outcomes(results)).toBe(1);
    expect(failed(results)[0]).toMatchObject({
      error: { category: "event_task_limit", code: "CF429" },
    });
  });

  it("an officer's last reassignment of the day goes to one of two, on different tasks", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const officer = fakeId();
    const made: TaskRow[] = [];
    for (let index = 0; index < 49; index += 1) {
      made.push(
        must(await createTask(db.db, newTask(guild.guildId, eventId, officer))),
      );
    }
    const reassign = (task: (typeof made)[number]) =>
      editTask(db.db, {
        guildId: guild.guildId,
        taskId: task.id,
        expectedUpdatedAt: task.updated_at,
        description: task.description,
        dueDate: task.due_date,
        assigneeId: fakeId(),
        actorId: officer,
      });
    const [one, other] = [made[0], made[1]];
    if (one === undefined || other === undefined) throw new Error("no tasks");
    const results = await Promise.all([reassign(one), reassign(other)]);
    expect(outcomes(results)).toBe(1);
    expect(failed(results)[0]).toMatchObject({
      error: { category: "actor_task_limit", code: "CF430" },
    });
  });
});
