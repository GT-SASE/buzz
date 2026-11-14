/**
 * The daily task reminder run, the health check, the job lock and the cron endpoint
 * against the real schema, with Discord mocked at `fetch`.
 */

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as endpoint from "../../api/cron/reminders.ts";
import {
  pgliteSql,
  serverError,
  testDatabaseUrl,
} from "../support/sql-client.ts";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import { stubEnv } from "../support/stubs.ts";
import {
  beginJobRun,
  getLatestJobRun,
  getLatestSucceededJobRun,
} from "../../src/db/job-runs.ts";
import { runDailyJobs } from "../../src/reminders/daily.ts";
import { jobFreshness, runHealthCheck } from "../../src/reminders/health.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import {
  FIXTURE_DUE_DATE,
  finishEventSteps,
  insertEvent,
  insertGuild,
  insertTask,
  type GuildFixture,
} from "./fixtures.ts";
import {
  INSUFFICIENT_PRIVILEGE,
  MIGRATION_OWNER,
  OTHER_ROLE,
  errorCodeOf,
  fakeId,
  present,
  queryAs,
} from "./harness.ts";
import { dateOffset, useReminderWorld } from "./reminder-world.ts";

const SECRET = "c".repeat(40);

const w = useReminderWorld();

// The cron endpoint's own client runs on the same database.
void mock.module("../../src/db/neon.ts", () => ({
  neonRunner: () => pgliteSql(w.database, (call) => w.sqlGate(call)),
}));

async function eventWithThread(
  guild: GuildFixture,
  name = "General meeting",
): Promise<{ eventId: string; threadId: string }> {
  const threadId = w.addThread(guild);
  const rows = await queryAs<{ id: string }>(
    w.database,
    "bot_app",
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
     VALUES ($1, $2, $3, '2030-01-15', $4, $5, 'active')
     RETURNING id`,
    [guild.guildId, guild.channelId, name, fakeId(), threadId],
  );
  const eventId = present(rows[0]).id;
  // These tests are about task reminders, so the event's step list has nothing to say.
  await finishEventSteps(w.database, eventId);
  return { eventId, threadId };
}

async function task(
  guild: GuildFixture,
  eventId: string,
  dueDate: string,
  description = "Book the room",
  assigneeId = fakeId(),
): Promise<string> {
  const rows = await queryAs<{ id: string }>(
    w.database,
    "bot_app",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [eventId, guild.guildId, assigneeId, description, dueDate, fakeId()],
  );
  return present(rows[0]).id;
}

/** One event per entry, each holding one task due in that many days. */
async function eventsDueIn(guild: GuildFixture, days: number[]) {
  const events = [];
  for (const offset of days) {
    const event = await eventWithThread(guild);
    events.push({
      ...event,
      taskId: await task(guild, event.eventId, dateOffset(offset)),
    });
  }
  return events;
}

interface LogRow {
  task_id: string;
  kind: string;
  state: string;
  attempts: number;
  message_id: string | null;
  refused_attempts: number;
}

async function logRows(taskId: string): Promise<LogRow[]> {
  const { rows } = await w.database.query<LogRow>(
    `SELECT task_id, kind, state, attempts, message_id, refused_attempts
     FROM public.reminder_log WHERE task_id = $1 ORDER BY kind`,
    [taskId],
  );
  return rows;
}

async function allLogRows(taskIds: string[]): Promise<LogRow[]> {
  return (await Promise.all(taskIds.map(logRows))).flat();
}

/** Claims a reminder as an earlier run would have, and lets the claim go stale. */
async function staleClaim(
  taskId: string,
  kind: string,
  dueDate: string,
  attempts = 1,
): Promise<void> {
  await queryAs(
    w.database,
    "bot_app",
    `SELECT public.claim_reminder($1, $2, $3)`,
    [taskId, kind, dueDate],
  );
  await w.database.query(
    `UPDATE public.reminder_log SET attempts = $2, claimed_at = now() - interval '2 hours'
     WHERE task_id = $1`,
    [taskId, attempts],
  );
}

/** The 17:00 cron, by which time a morning claim has gone stale. */
async function staleAllClaims(): Promise<void> {
  await w.database.exec(
    `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
  );
}

/** Moves the clock on by a day as far as the lock and the claims can tell. */
async function nextDay(): Promise<void> {
  await w.database.exec(`
    UPDATE public.job_runs
    SET started_at = started_at - interval '25 hours',
        heartbeat_at = heartbeat_at - interval '25 hours'
    WHERE job_name = 'reminders';
    UPDATE public.reminder_log SET claimed_at = claimed_at - interval '25 hours';
  `);
}

/** A finished run of the job this many hours ago. */
async function succeededRun(jobName: string, hoursAgo: number): Promise<void> {
  await insertFinishedJobRun(w.database, {
    jobName,
    status: "succeeded",
    startedAt: new Date(Date.now() - hoursAgo * 3_600_000),
  });
}

const unavailable503 = () => new Response("unavailable", { status: 503 });

describe("a normal run", () => {
  it("claims, sends once to the thread and marks sent", async () => {
    const guild = await w.guildInZone();
    const { eventId, threadId } = await eventWithThread(guild, "Spring gala");
    const assignee = fakeId();
    const taskId = await task(
      guild,
      eventId,
      dateOffset(1),
      "Book it",
      assignee,
    );
    const notYetDue = await task(guild, eventId, dateOffset(4));

    const result = await w.run([guild]);

    expect(result.status).toBe("succeeded");
    expect(w.sent).toHaveLength(1);
    const message = present(w.sent[0]);
    expect(message.threadId).toBe(threadId);
    expect(message.users).toEqual([assignee]);
    expect(message.parse).toEqual([]);
    expect((message.flags ?? 0) & 4).toBe(4);
    expect(message.content).toContain("Spring gala");
    expect(message.content).toContain(`<@${assignee}>`);
    expect(message.content).toContain("Book it");
    expect(message.content).toContain("1 day left");
    expect(message.buttons).toEqual([`task.done:${taskId}`]);
    const rows = await logRows(taskId);
    expect(rows).toMatchObject([
      { kind: "three_days", state: "skipped" },
      { kind: "one_day", state: "sent", attempts: 1 },
    ]);
    expect(rows[1]?.message_id).toMatch(/^[0-9]+$/);
    expect(await logRows(notYetDue)).toEqual([]);
    expect((await w.jobRow()).results).toMatchObject({
      messages_sent: 1,
      reminders_sent: 1,
    });
  });

  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await w.guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    await w.run([]);
    expect(w.requests).toEqual([]);
    expect(await logRows(present(event).taskId)).toEqual([]);
    expect((await w.jobRow()).results).toMatchObject({ guilds_not_allowed: 1 });
  });

  it("sends once when invoked twice in a row", async () => {
    const guild = await w.guildInZone();
    await eventsDueIn(guild, [3]);

    expect((await w.run([guild])).status).toBe("succeeded");
    w.requests = [];
    // The same slot's recovery cron, or a second delivery of the first.
    expect((await w.run([guild])).status).toBe("duplicate");

    expect(w.requests).toEqual([]);
    expect(w.sent).toHaveLength(1);
  });

  it("leaves what is over the message cap unclaimed for the next day", async () => {
    const guild = await w.guildInZone();
    const events = await eventsDueIn(guild, [3, 3, 3]);

    const result = await w.run([guild], { limits: { maxMessages: 2 } });

    expect(result.status).toBe("succeeded");
    expect(w.sent).toHaveLength(2);
    expect((await w.jobRow()).results).toMatchObject({
      messages_sent: 2,
      deferred_cap: 1,
    });
    expect(w.logLines.join("\n")).toContain("message cap");
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      2,
    );
    // A same-day repeat must not send the remainder.
    expect((await w.run([guild])).status).toBe("duplicate");
    expect(w.sent).toHaveLength(2);

    await nextDay();
    await w.run([guild]);
    expect(w.sent).toHaveLength(3);
  });

  it("skips text Discord refuses without blocking the others in its message", async () => {
    const poison = "forbiddenword";
    const guild = await w.guildInZone();
    const { eventId } = await eventWithThread(guild);
    const good = await task(guild, eventId, dateOffset(3), "Good one");
    const bad = await task(guild, eventId, dateOffset(3), poison);
    const other = await task(guild, eventId, dateOffset(3), "Good two");
    w.discordGate = (method, _path, message) =>
      method === "POST" && message?.content.includes(poison)
        ? Response.json({ code: 200000 }, { status: 400 })
        : undefined;

    const result = await w.run([guild]);

    expect(result.status).toBe("succeeded");
    expect(w.sent.map((message) => message.content).join()).not.toContain(
      poison,
    );
    expect(await allLogRows([good, other, bad])).toMatchObject([
      { state: "sent" },
      { state: "sent" },
      { state: "skipped" },
    ]);
    expect((await w.jobRow()).results).toMatchObject({
      items_refused: 1,
      batches_retried: 1,
      reminders_sent: 2,
    });
    expect(w.logLines.join("\n")).toContain(bad);
    expect(w.logLines.join("\n")).not.toContain(poison);
  });
});

describe("crashes", () => {
  it("between send and mark, leaves the claim, then resends exactly once the next day", async () => {
    const guild = await w.guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    const taskId = present(event).taskId;
    // After the first send, every database request fails, as if the process died.
    let crashed = false;
    w.discordGate = (method) => {
      crashed ||= method === "POST";
      return undefined;
    };
    w.sqlGate = () => (crashed ? serverError("XX000") : undefined);

    await w.run([guild]);
    expect(w.sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    crashed = false;
    w.discordGate = () => undefined;
    w.sqlGate = () => undefined;

    // The dead run's row is still 'running', and a fresh claim is left alone.
    expect((await w.run([guild])).status).toBe("duplicate");
    expect(w.sent).toHaveLength(1);

    await nextDay();
    expect((await w.run([guild])).status).toBe("succeeded");
    expect(w.sent).toHaveLength(2);
    expect(await logRows(taskId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);

    await nextDay();
    await w.run([guild]);
    expect(w.sent).toHaveLength(2);
  });

  // The last catch in runReminders: if it recorded nothing, the crashed run would count
  // as a success and the lock would refuse the recovery cron.
  it("records a throw outside the per-event work as failed, and the next run still sends", async () => {
    const guild = await w.guildInZone();
    await eventsDueIn(guild, [1]);
    // The run reads the clock for its slot when it is built and first thing in its
    // work, so a throw on the third read lands in the work and nowhere else.
    let reads = 0;
    const clock = () => {
      reads += 1;
      if (reads === 3) {
        throw new TypeError("clock failure");
      }
      return new Date();
    };

    expect(await w.run([guild], { now: clock })).toMatchObject({
      status: "failed",
      error: "unexpected",
    });
    expect(w.posts()).toEqual([]);
    expect(await w.jobRow()).toMatchObject({
      status: "failed",
      error: "unexpected",
    });

    expect((await w.run([guild])).status).toBe("succeeded");
    expect(w.sent).toHaveLength(1);
  });
});

describe("failures that stop the run", () => {
  it.each<[string, () => Response, string]>([
    [
      "the first 401",
      () => Response.json({ code: 0 }, { status: 401 }),
      "discord_unauthorized:401",
    ],
    [
      "a global rate limit",
      () =>
        Response.json(
          { retry_after: 1, global: true },
          { status: 429, headers: { "x-ratelimit-scope": "global" } },
        ),
      "discord_rate_limited:429",
    ],
  ])("stops on %s after exactly one request", async (_label, answer, error) => {
    const guild = await w.guildInZone();
    const events = await eventsDueIn(guild, [3, 3]);
    w.discordGate = answer;

    const result = await w.run([guild]);

    expect(w.requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", error });
    const row = await w.jobRow();
    expect(row).toMatchObject({ status: "failed", error });
    expect(row.results).toMatchObject({ deferred_halted: 1 });
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      1,
    );
  });

  it("stops at a failure that may clear, and the 17:00 run sends what it left", async () => {
    const guild = await w.guildInZone();
    const events = await eventsDueIn(guild, [3, 3, 3]);
    const taskIds = events.map((event) => event.taskId);
    w.discordGate = (method) =>
      method === "POST" ? unavailable503() : undefined;

    const morning = await w.run([guild]);

    expect(w.posts()).toHaveLength(1);
    expect(morning).toMatchObject({
      status: "failed",
      error: "discord_api:503",
    });
    expect((await w.jobRow()).results).toMatchObject({
      retry_later: 1,
      deferred_halted: 2,
    });
    expect(await allLogRows(taskIds)).toHaveLength(1);
    // What the health check's freshness alert reads.
    const latest = () =>
      getLatestSucceededJobRun(w.db, { jobName: "reminders" });
    expect(await latest()).toEqual({ ok: true, value: null });

    w.discordGate = () => undefined;
    await staleAllClaims();
    expect((await w.run([guild])).status).toBe("succeeded");

    expect(w.sent).toHaveLength(3);
    expect(await allLogRows(taskIds)).toMatchObject([
      { state: "sent" },
      { state: "sent" },
      { state: "sent" },
    ]);
    expect(await latest()).toMatchObject({
      ok: true,
      value: { job_name: "reminders", status: "succeeded" },
    });
  });

  it.each<[string, number]>([
    ["due today", 0],
    ["due tomorrow", 1],
  ])(
    "after a failed morning and a rerun, leaves the slot to the recovery cron, for a task %s",
    async (_label, days) => {
      const guild = await w.guildInZone();
      const { eventId, threadId } = await eventWithThread(guild);
      const person = fakeId();
      const taskId = await task(guild, eventId, dateOffset(days), "B", person);

      w.discordGate = (method) =>
        method === "POST" ? unavailable503() : undefined;
      expect((await w.run([guild])).status).toBe("failed");
      // A second delivery or a by-hand run, with Discord working again.
      w.discordGate = () => undefined;
      expect(await w.run([guild])).toMatchObject({
        status: "failed",
        error: "reminders_incomplete",
      });
      expect(w.sent).toEqual([]);
      expect((await w.jobRow()).results).toMatchObject({
        fresh_claims_waiting: 1,
      });

      await staleAllClaims();
      expect((await w.run([guild])).status).toBe("succeeded");
      expect(w.sent.map((message) => message.threadId)).toEqual([threadId]);
      expect(present(w.sent[0]).users).toEqual([person]);
      expect(await logRows(taskId)).toContainEqual(
        expect.objectContaining({ state: "sent" }) as LogRow,
      );
    },
  );
});

describe("targets that fail", () => {
  it("marks the forum, and skips its other events, only when a GET says it is gone", async () => {
    const guild = await w.guildInZone();
    const events = await eventsDueIn(guild, [3, 3]);
    w.discordGate = () => Response.json({ code: 10003 }, { status: 404 });

    const result = await w.run([guild]);

    expect(result.status).toBe("succeeded");
    const { rows } = await w.database.query<{ status: string }>(
      `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
      [guild.guildId],
    );
    expect(rows).toEqual([{ status: "unavailable" }]);
    expect(w.requests).toHaveLength(2);
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      1,
    );
    expect((await w.jobRow()).results).toMatchObject({
      channels_gone: 1,
      claim_lost: 1,
    });
  });

  it("sends nothing to a thread whose parent is not managed, and keeps the claim", async () => {
    const guild = await w.guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    const { threadId, taskId } = present(event);
    w.channels.set(threadId, {
      id: threadId,
      type: 11,
      guild_id: guild.guildId,
      parent_id: fakeId(),
    });

    const result = await w.run([guild]);

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(w.posts()).toEqual([]);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    expect((await w.jobRow()).results).toMatchObject({ retry_later: 1 });
  });
});

describe("the repeat-ping guard", () => {
  it.each<[number, boolean]>([
    [1, true],
    [2, false],
  ])(
    "after %i earlier attempts, pings the assignee: %p",
    async (attempts, pings) => {
      const guild = await w.guildInZone();
      const { eventId } = await eventWithThread(guild);
      const person = fakeId();
      const taskId = await task(guild, eventId, dateOffset(3), "Book", person);
      await staleClaim(taskId, "three_days", dateOffset(3), attempts);

      await w.run([guild]);

      expect(w.sent).toHaveLength(1);
      expect(present(w.sent[0]).users).toEqual(pings ? [person] : []);
      expect(present(w.sent[0]).content).toContain(`<@${person}>`);
      expect(await logRows(taskId)).toMatchObject([
        { state: "sent", attempts: attempts + 1 },
      ]);
    },
  );

  // A refusal shows the send did not land, so the next send still pings. A failure
  // that may have landed counts as an attempt, and the guard withholds the ping.
  it.each<[string, () => Response, boolean, number]>([
    [
      "a missing permission",
      () => Response.json({ code: 50013 }, { status: 403 }),
      true,
      2,
    ],
    ["a server error", unavailable503, false, 0],
  ])(
    "after two runs ending in %s, pings on the third: %p",
    async (_label, answer, pings, refused) => {
      const guild = await w.guildInZone();
      const person = fakeId();
      const { eventId } = await eventWithThread(guild);
      const taskId = await task(guild, eventId, dateOffset(-5), "Book", person);

      w.discordGate = (method) => (method === "POST" ? answer() : undefined);
      await w.run([guild]);
      await nextDay();
      await w.run([guild]);
      await nextDay();
      w.discordGate = () => undefined;
      await w.run([guild]);

      expect(w.sent).toHaveLength(1);
      expect(present(w.sent[0]).users).toEqual(pings ? [person] : []);
      expect(await logRows(taskId)).toContainEqual(
        expect.objectContaining({
          kind: "overdue",
          refused_attempts: refused,
        }) as LogRow,
      );
    },
  );

  it("does not ping the old assignee of a task changed after the run read it", async () => {
    const guild = await w.guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(1), "Sent first");
    const taskId = await task(guild, second.eventId, dateOffset(3), "Old");
    const after = fakeId();
    let changed = false;
    w.discordGate = async (method) => {
      if (method === "POST" && !changed) {
        changed = true;
        await w.database.query(
          `UPDATE public.tasks SET assignee_id = $2, description = 'New text' WHERE id = $1`,
          [taskId, after],
        );
      }
      return undefined;
    };

    expect(await w.run([guild])).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    expect((await w.jobRow()).results).toMatchObject({ claim_outdated: 1 });
    expect(w.sent).toHaveLength(1);
    expect(await logRows(taskId)).toEqual([]);

    // The recovery cron pings the new one.
    expect((await w.run([guild])).status).toBe("succeeded");
    const last = present(w.sent.at(-1));
    expect(last.threadId).toBe(second.threadId);
    expect(last.users).toEqual([after]);
    expect(last.content).toContain("New text");
  });
});

describe("stale claims on tasks the plan left out", () => {
  it("leaves the claim alone for a guild no longer allowed", async () => {
    const guild = await w.guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    const { taskId } = present(event);
    await staleClaim(taskId, "three_days", dateOffset(3));
    await w.run([]);
    expect(await logRows(taskId)).toMatchObject([
      { state: "claimed", attempts: 1 },
    ]);
  });

  it.each([
    [
      "its thread is missing",
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
    ],
    [
      "its task is done",
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE event_id = $1`,
    ],
    [
      "its forum is no longer managed",
      `UPDATE public.managed_channels SET status = 'removed'
       WHERE (guild_id, channel_id) = (SELECT guild_id, channel_id FROM public.events WHERE id = $1)`,
    ],
  ])("closes the claim as skipped when %s", async (_label, change) => {
    const guild = await w.guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    const { eventId, taskId } = present(event);
    await staleClaim(taskId, "three_days", dateOffset(3));
    await w.database.query(change, [eventId]);

    expect((await w.run([guild])).status).toBe("succeeded");
    expect(await logRows(taskId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
    expect(w.posts()).toEqual([]);
  });
});

describe("each guild's own zone", () => {
  // Midnight in Singapore falls between the two crons: 23:00 and then 01:00 there.
  it.each(["2026-11-04T15:00:00Z", "2026-11-04T17:00:00Z"])(
    "plans the same Singapore day at %s",
    async (at) => {
      const guild = await w.guildInZone("Asia/Singapore");
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, "2026-11-05");

      await w.run([guild], { now: new Date(at) });

      expect(w.sent).toHaveLength(1);
      expect(present(w.sent[0]).content).toContain("1 day left");
    },
  );

  it("uses each guild's own date", async () => {
    const auckland = await w.guildInZone("Pacific/Auckland");
    const newYork = await w.guildInZone("America/New_York");
    const aucklandEvent = await eventWithThread(auckland);
    const newYorkEvent = await eventWithThread(newYork);
    await task(auckland, aucklandEvent.eventId, "2026-11-05");
    await task(newYork, newYorkEvent.eventId, "2026-11-05");

    await w.run([auckland, newYork], { now: new Date("2026-11-04T15:00:00Z") });

    const byThread = new Map(
      w.sent.map((message) => [message.threadId, message.content]),
    );
    expect(byThread.get(aucklandEvent.threadId)).toContain("due today");
    expect(byThread.get(newYorkEvent.threadId)).toContain("1 day left");
  });
});

describe("reminder claims check the task's parents", () => {
  const turnOff = `SELECT public.apply_config_change($1, 2, $1, false)`;
  /** Each change, given the guild, must stop new claims and takeovers. */
  const STOPPERS: [string, string, string][] = [
    ["reminders turned off", "bot_app", turnOff],
    [
      "the channel removed",
      MIGRATION_OWNER,
      `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
    ],
    [
      "the channel unavailable",
      "bot_app",
      `SELECT public.mark_channel_unavailable(guild_id, channel_id)
       FROM public.managed_channels WHERE guild_id = $1`,
    ],
    [
      "the event closed",
      "bot_app",
      `UPDATE public.events SET status = 'closed' WHERE guild_id = $1`,
    ],
    [
      "the event deleted with its task left live",
      MIGRATION_OWNER,
      `UPDATE public.events SET deleted_at = now() WHERE guild_id = $1`,
    ],
  ];

  async function openTask() {
    const guild = await insertGuild(w.database);
    const taskId = await insertTask(
      w.database,
      guild,
      await insertEvent(w.database, guild),
    );
    const stop = (role: string, sql: string) =>
      queryAs(w.database, role, sql, [guild.guildId]);
    return { taskId, stop };
  }

  async function tokenOf(sql: string, params: unknown[]) {
    const rows = await queryAs<{ token: string | null }>(
      w.database,
      "bot_app",
      sql,
      params,
    );
    return rows[0]?.token ?? null;
  }

  const claim = (taskId: string) =>
    tokenOf(
      `SELECT public.claim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}') AS token`,
      [taskId],
    );

  async function staleThenReclaim(taskId: string, token: string | null) {
    await w.database.query(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours' WHERE task_id = $1`,
      [taskId],
    );
    return tokenOf(
      `SELECT public.reclaim_reminder($1, 'due_day', '${FIXTURE_DUE_DATE}', $2, 120) AS token`,
      [taskId, token ?? ""],
    );
  }

  it("takes over a stale claim when nothing has stopped reminders", async () => {
    const { taskId } = await openTask();
    const token = await claim(taskId);
    expect(token).not.toBeNull();
    expect(await staleThenReclaim(taskId, token)).not.toBeNull();
  });

  it.each(STOPPERS)(
    "refuses a new claim after %s",
    async (_name, role, sql) => {
      const { taskId, stop } = await openTask();
      await stop(role, sql);
      expect(await claim(taskId)).toBeNull();
      expect(await logRows(taskId)).toEqual([]);
    },
  );

  it.each(STOPPERS)("refuses a takeover after %s", async (_name, role, sql) => {
    const { taskId, stop } = await openTask();
    const token = await claim(taskId);
    await stop(role, sql);
    expect(await staleThenReclaim(taskId, token)).toBeNull();
    const { rows } = await w.database.query(
      `SELECT attempts, claim_token AS token FROM public.reminder_log WHERE task_id = $1`,
      [taskId],
    );
    expect(rows).toEqual([{ attempts: 1, token }]);
  });

  it("is not stopped by another guild turning reminders off", async () => {
    const { taskId } = await openTask();
    const other = await insertGuild(w.database);
    await queryAs(w.database, "bot_app", turnOff, [other.guildId]);
    expect(await claim(taskId)).not.toBeNull();
  });
});

describe("the job lock", () => {
  const currentSlot = (): Date => new Date(slotStart(new Date()));

  const beginOk = async () => {
    const result = await beginJobRun(w.db, {
      jobName: "reminders",
      staleAfterSeconds: 120,
      slotStart: currentSlot(),
    });
    if (!result.ok) {
      throw new Error(result.error.category);
    }
    return result.value;
  };

  const insertRun = (status: "succeeded" | "failed", startedAt: Date) =>
    insertFinishedJobRun(w.database, { status, startedAt });

  it("gives the first caller a run and refuses a second while it is live", async () => {
    const id = present(await beginOk());
    expect(await getLatestJobRun(w.db, { jobName: "reminders" })).toMatchObject(
      {
        ok: true,
        value: { id, status: "running" },
      },
    );
    expect(await beginOk()).toBeNull();
  });

  it.each([
    [
      "makes the later cron a no-op after a good morning run",
      "succeeded",
      0,
      false,
    ],
    ["lets the later cron run after a failed morning run", "failed", 0, true],
    [
      "does not count a success from before this slot",
      "succeeded",
      -1000,
      true,
    ],
    ["does not count a success stamped in the future", "succeeded", 1e12, true],
  ] as const)("%s", async (_name, status, offsetMs, runs) => {
    await insertRun(status, new Date(currentSlot().getTime() + offsetMs));
    expect((await beginOk()) !== null).toBe(runs);
  });

  it("works the slot out in UTC whatever the session's zone", async () => {
    await w.database.exec(`SET TIME ZONE 'Pacific/Auckland'`);
    try {
      await insertRun("succeeded", new Date(currentSlot().getTime() - 1000));
      expect(await beginOk()).not.toBeNull();
      await w.database.exec(`DELETE FROM public.job_runs`);
      await insertRun("succeeded", currentSlot());
      expect(await beginOk()).toBeNull();
    } finally {
      await w.database.exec(`SET TIME ZONE 'UTC'`);
    }
  });

  it("closes a run the platform killed and starts a new one", async () => {
    const dead = present(await beginOk());
    await w.database.query(
      `UPDATE public.job_runs SET heartbeat_at = now() - interval '3 minutes'`,
    );
    expect(present(await beginOk())).not.toBe(dead);
    const { rows } = await w.database.query(
      `SELECT status, error FROM public.job_runs WHERE id = $1`,
      [dead],
    );
    expect(rows).toEqual([{ status: "failed", error: "abandoned" }]);
  });

  it.each([
    `SELECT public.begin_job_run('reminders', 1, now())`,
    `SELECT public.finish_job_run(gen_random_uuid(), now(), '{}', NULL)`,
  ])("is closed to a role with no grants: %s", async (sql) => {
    expect(await errorCodeOf(queryAs(w.database, OTHER_ROLE, sql))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe("the health check", () => {
  function health(
    allowed: readonly GuildFixture[],
    options: { deadlineMs?: number } = {},
  ) {
    return runHealthCheck({
      db: w.db,
      client: w.client(),
      allowedGuildIds: new Set(allowed.map((guild) => guild.guildId)),
      log: (line) => w.logLines.push(line),
      ...options,
    });
  }

  function daily(guild: GuildFixture) {
    return runDailyJobs({
      db: w.db,
      client: w.client(),
      allowedGuildIds: new Set([guild.guildId]),
    });
  }

  async function channelStatus(guild: GuildFixture) {
    const { rows } = await w.database.query<{ status: string }>(
      `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
      [guild.guildId],
    );
    return rows[0]?.status;
  }

  const healthResults = async () => (await w.jobRow("health_check")).results;

  it("makes one GET per channel and posts nothing", async () => {
    const one = await w.guildInZone();
    const two = await w.guildInZone();

    expect((await health([one, two])).status).toBe("succeeded");

    expect(w.requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        `GET /channels/${one.channelId}`,
        `GET /channels/${two.channelId}`,
      ].sort(),
    );
    expect(await healthResults()).toMatchObject({ channels_ok: 2 });
  });

  it.each([
    ["Unknown Channel", 404, 10003, "unavailable", "channels_gone"],
    ["an outage", 503, 0, "active", "channels_unknown"],
    ["Missing Access", 403, 50001, "active", "channels_inaccessible"],
  ])(
    "on %s, leaves the channel %s",
    async (_label, status, code, after, counter) => {
      const guild = await w.guildInZone();
      w.discordGate = () => Response.json({ code }, { status });
      await health([guild]);
      expect(await channelStatus(guild)).toBe(after);
      expect(await healthResults()).toMatchObject({ [counter]: 1 });
    },
  );

  it.each([
    ["for a guild no longer allowed", false, "guilds_not_allowed"],
    ["past the deadline", true, "channels_not_reached"],
  ])("makes no request %s", async (_label, allowed, counter) => {
    const guild = await w.guildInZone();
    await health(allowed ? [guild] : [], { deadlineMs: allowed ? 0 : 1e15 });
    expect(w.requests).toEqual([]);
    expect(await channelStatus(guild)).toBe("active");
    expect(await healthResults()).toMatchObject({ [counter]: 1 });
  });

  it("reads a job as never run, fresh, stale or future-dated", async () => {
    expect(await jobFreshness(w.db, "reminders", new Date())).toEqual({
      state: "never",
    });
    await succeededRun("reminders", 0);
    // A clock a minute behind the database's still reads it as fresh.
    const minuteBefore = new Date(Date.now() - 60_000);
    expect(await jobFreshness(w.db, "reminders", minuteBefore)).toEqual({
      state: "fresh",
      ageHours: 0,
    });
    await w.database.exec(`DELETE FROM public.job_runs`);
    await succeededRun("reminders", 30);
    expect(await jobFreshness(w.db, "reminders", new Date())).toEqual({
      state: "stale",
      ageHours: 30,
    });
    // A success hours after "now" is not trusted.
    const hoursBefore = new Date(Date.now() - 31 * 3_600_000);
    expect(await jobFreshness(w.db, "reminders", hoursBefore)).toEqual({
      state: "future",
    });
  });

  it.each([
    [40, 1],
    [24, 0],
  ])(
    "after a reminder run %i hours ago, flags the gap: %i",
    async (hours, stale) => {
      const guild = await w.guildInZone();
      await succeededRun("reminders", hours);
      await succeededRun("health_check", hours);

      expect(await daily(guild)).toBe(true);

      expect(await healthResults()).toMatchObject({
        reminders_stale: stale,
        reminders_age_hours: hours,
      });
    },
  );

  it("runs after the reminders, and a rerun is a duplicate, not a failure", async () => {
    const guild = await w.guildInZone();
    expect(await daily(guild)).toBe(true);
    const { rows } = await w.database.query(
      `SELECT job_name, status FROM public.job_runs ORDER BY job_name`,
    );
    expect(rows).toEqual([
      { job_name: "health_check", status: "succeeded" },
      { job_name: "reminders", status: "succeeded" },
    ]);
    expect(await healthResults()).toMatchObject({ health_check_never_run: 1 });

    w.requests = [];
    expect(await daily(guild)).toBe(true);
    expect(w.requests).toEqual([]);
  });

  it("is left for the next cron when out of time", async () => {
    const guild = await w.guildInZone();
    const base = Date.now();
    spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 41_000);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await daily(guild)).toBe(true);

    expect(w.requests).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).toContain("out of time");
  });
});

/**
 * The cron endpoint with an authorized request, from the handler down to the schema.
 * Refusals and the deployment settings are in src/reminders/cron-endpoint.test.ts.
 */
describe("the cron endpoint", () => {
  let threadId: string;

  const get = () =>
    endpoint.GET(
      new Request("https://bot.example.test/api/cron/reminders", {
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );

  /** Sets the function's settings for a guild with a task due in two days. */
  async function guildWithTaskDue() {
    const guild = await w.guildInZone();
    threadId = present((await eventsDueIn(guild, [2]))[0]).threadId;
    stubEnv("DATABASE_URL", testDatabaseUrl());
    stubEnv("CRON_SECRET", SECRET);
    stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
    stubEnv("DISCORD_APP_ID", fakeId());
    stubEnv("ALLOWED_GUILD_IDS", guild.guildId);
    return guild;
  }

  const sentTo = () => w.sent.map((message) => message.threadId);

  beforeEach(() => {
    spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it.each([
    ["when another run holds the lock", true],
    ["after a real run", false],
  ])("returns a fixed body %s", async (_label, locked) => {
    await guildWithTaskDue();
    if (locked) {
      await w.database.exec(
        `INSERT INTO public.job_runs (job_name) VALUES ('reminders'), ('health_check')`,
      );
    }

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sentTo()).toEqual(locked ? [] : [threadId]);
  });

  it("gives a fixed 500 and no detail when the database fails", async () => {
    await guildWithTaskDue();
    w.sqlGate = () => serverError("XX000", "row text");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await get();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(JSON.stringify(warn.mock.calls)).toContain("unavailable:XX000");
  });

  it("does not remember a refused token from an earlier run", async () => {
    await guildWithTaskDue();
    let tokenRefused = true;
    w.discordGate = () =>
      tokenRefused ? new Response("{}", { status: 401 }) : undefined;
    await get();
    expect(w.requests).toHaveLength(1);

    tokenRefused = false;
    await staleAllClaims();
    await get();
    expect(sentTo()).toEqual([threadId]);
  });

  it("checks the forum again just before it sends", async () => {
    // The forum is removed after the run reads the task, while it looks up the thread.
    const guild = await guildWithTaskDue();
    w.discordGate = async (method) => {
      if (method !== "POST") {
        await w.database.query(
          `UPDATE public.managed_channels SET status = 'removed' WHERE guild_id = $1`,
          [guild.guildId],
        );
      }
      return undefined;
    };

    await get();

    expect(w.requests).not.toEqual([]);
    expect(w.posts()).toEqual([]);
  });
});
