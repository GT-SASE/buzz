/**
 * The reminder run against the real schema, with Discord mocked at `fetch`. The
 * database's own functions decide every claim, so these exercise the same paths as
 * production apart from the network.
 */

import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  pgliteSql,
  names,
  serverError,
  unavailable,
  type Intercept,
} from "../support/sql-client.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { getLatestSucceededJobRun } from "../../src/db/job-runs.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { slotStart, STALE_CLAIM_MS } from "../../src/reminders/plan.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import {
  DATABASE_CALL_MS,
  DISCORD_OPERATION_MS,
  RUN_HARD_STOP_MS,
  THREAD_REFUSALS_BEFORE_HOLD,
  runReminders,
  type RunLimits,
  type RunResult,
} from "../../src/reminders/run.ts";
import { messageBody } from "../support/json.ts";
import {
  finishEventSteps,
  insertGuild,
  type GuildFixture,
} from "./fixtures.ts";
import { createMigratedDb, fakeId, present, queryAs } from "./harness.ts";

const planHook = vi.hoisted(() => ({ invalidTaskIds: [] as string[] }));

vi.mock("../../src/reminders/plan.ts", async (original) => {
  const actual = await original<typeof import("../../src/reminders/plan.ts")>();
  return {
    ...actual,
    planReminders: (
      input: Parameters<typeof actual.planReminders>[0],
    ): ReturnType<typeof actual.planReminders> => {
      const plan = actual.planReminders(input);
      plan.invalidTaskIds.push(...planHook.invalidTaskIds);
      return plan;
    },
  };
});

const API = "https://discord.com/api/v10";
const TOKEN = "unit-test-token";

interface Sent {
  threadId: string;
  content: string;
  users: string[];
  flags: number;
  parse: string[];
  buttons: string[];
}

type DiscordAnswer = Response | undefined;

let database: PGlite;
let db: DbClient;
/** Lets a test answer, fail or watch one statement. */
let sqlGate: Intercept;
/** Lets a test refuse or react to one Discord request. */
let discordGate: (
  method: string,
  path: string,
  sent: Sent | undefined,
) => DiscordAnswer | Promise<DiscordAnswer>;
let requests: { method: string; path: string }[];
let sent: Sent[];
let threadParents: Map<string, { guildId: string; parentId: string }>;
let logLines: string[];

function posts() {
  return requests.filter((request) => request.method === "POST");
}

function mockDiscord(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const url = input;
    if (!url.startsWith(API)) {
      throw new Error(`Unexpected request to ${url}`);
    }
    const path = url.slice(API.length);
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    let message: Sent | undefined;
    const threadId = /^\/channels\/([0-9]+)/.exec(path)?.[1] ?? "";
    if (method === "POST") {
      const body = messageBody(init?.body);
      if (body.flags === undefined) {
        throw new Error("a reminder must set its flags");
      }
      message = {
        threadId,
        content: body.content,
        users: body.users,
        parse: body.parse,
        flags: body.flags,
        buttons: body.buttons,
      };
    }
    const answer = await discordGate(method, path, message);
    if (answer !== undefined) {
      return answer;
    }
    if (message !== undefined) {
      sent.push(message);
      return Response.json({ id: fakeId() });
    }
    const thread = threadParents.get(threadId);
    return thread === undefined
      ? Response.json({ id: threadId, type: 15, guild_id: "0" })
      : Response.json({
          id: threadId,
          type: 11,
          guild_id: thread.guildId,
          parent_id: thread.parentId,
        });
  });
}

function discordClient() {
  return createDiscordClient({
    check: managedChannelCheck(db),
    env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: fakeId() },
    sleep: () => Promise.resolve(),
  });
}

interface RunOptions {
  guilds: readonly GuildFixture[];
  now?: Date | (() => Date);
  limits?: Partial<RunLimits>;
}

function run({ guilds, now, limits }: RunOptions): Promise<RunResult> {
  return runReminders({
    db,
    client: discordClient(),
    allowedGuildIds: new Set(guilds.map((guild) => guild.guildId)),
    log: (line) => logLines.push(line),
    ...(now === undefined
      ? {}
      : { now: typeof now === "function" ? now : () => now }),
    ...(limits === undefined ? {} : { limits }),
  });
}

/** The date a run plans for in a UTC guild: that of its slot's start, not of the run. */
function todayUtc(): string {
  return dateOffset(0);
}

function dateOffset(days: number, from = new Date()): string {
  return new Date(slotStart(from) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A guild whose zone is UTC, so test dates and "today" agree. */
async function guildInZone(timezone = "UTC"): Promise<GuildFixture> {
  const guild = await insertGuild(database);
  await database.query(
    `UPDATE public.guild_config SET timezone = $2 WHERE guild_id = $1`,
    [guild.guildId, timezone],
  );
  return guild;
}

async function eventWithThread(
  guild: GuildFixture,
  name = "General meeting",
): Promise<{ eventId: string; threadId: string }> {
  const threadId = fakeId();
  threadParents.set(threadId, {
    guildId: guild.guildId,
    parentId: guild.channelId,
  });
  const rows = await queryAs<{ id: string }>(
    database,
    "bot_app",
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
     VALUES ($1, $2, $3, '2030-01-15', $4, $5, 'active')
     RETURNING id`,
    [guild.guildId, guild.channelId, name, fakeId(), threadId],
  );
  const eventId = present(rows[0]).id;
  // These tests are about task reminders, so the event's step list has nothing to say.
  await finishEventSteps(database, eventId);
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
    database,
    "bot_app",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [eventId, guild.guildId, assigneeId, description, dueDate, fakeId()],
  );
  return present(rows[0]).id;
}

interface LogRow {
  task_id: string;
  kind: string;
  state: string;
  attempts: number;
  message_id: string | null;
}

async function logRows(taskId: string): Promise<LogRow[]> {
  const { rows } = await database.query<LogRow>(
    `SELECT task_id, kind, state, attempts, message_id
     FROM public.reminder_log WHERE task_id = $1 ORDER BY kind`,
    [taskId],
  );
  return rows;
}

async function refusedAttempts(taskId: string, kind: string): Promise<number> {
  const { rows } = await database.query<{ refused_attempts: number }>(
    `SELECT refused_attempts FROM public.reminder_log WHERE task_id = $1 AND kind = $2`,
    [taskId, kind],
  );
  return present(rows[0]).refused_attempts;
}

async function jobRow() {
  const { rows } = await database.query<{
    status: string;
    results: Record<string, unknown>;
    error: string | null;
  }>(
    `SELECT status, results, error FROM public.job_runs
     WHERE job_name = 'reminders' ORDER BY started_at DESC LIMIT 1`,
  );
  return present(rows[0]);
}

/** Moves the clock on by a day as far as the lock and the claims can tell. */
async function nextDay(): Promise<void> {
  await database.exec(`
    UPDATE public.job_runs
    SET started_at = started_at - interval '25 hours',
        heartbeat_at = heartbeat_at - interval '25 hours'
    WHERE job_name = 'reminders';
    UPDATE public.reminder_log SET claimed_at = claimed_at - interval '25 hours';
  `);
}

beforeAll(async () => {
  database = await createMigratedDb();
  db = createDbClient(pgliteSql(database, (call) => sqlGate(call)));
});

afterAll(() => database.close());

beforeEach(async () => {
  sqlGate = () => undefined;
  discordGate = () => undefined;
  requests = [];
  sent = [];
  threadParents = new Map();
  logLines = [];
  planHook.invalidTaskIds = [];
  mockDiscord();
  await database.exec(`
    UPDATE public.tasks SET deleted_at = now() WHERE deleted_at IS NULL;
    DELETE FROM public.reminder_log;
    DELETE FROM public.event_reminder_log;
    DELETE FROM public.job_runs;
  `);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a normal run", () => {
  it("claims, sends once to the thread and marks sent", async () => {
    const guild = await guildInZone();
    const { eventId, threadId } = await eventWithThread(guild, "Spring gala");
    const assignee = fakeId();
    const dueDate = dateOffset(1);
    const taskId = await task(guild, eventId, dueDate, "Book it", assignee);

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    const message = present(sent[0]);
    expect(message.threadId).toBe(threadId);
    expect(message.users).toEqual([assignee]);
    expect(message.parse).toEqual([]);
    expect(message.flags & 4).toBe(4);
    expect(message.content).toContain("Spring gala");
    expect(message.content).toContain(`<@${assignee}>`);
    expect(message.content).toContain("Book it");
    expect(message.content).toContain("1 day left");
    const rows = await logRows(taskId);
    const row = rows.find((each) => each.kind === "one_day");
    expect(row).toMatchObject({ state: "sent", attempts: 1 });
    expect(row?.message_id).toMatch(/^[0-9]+$/);
    expect(rows.find((each) => each.kind === "three_days")?.state).toBe(
      "skipped",
    );
  });

  it("records only whole-number counts", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));

    await run({ guilds: [guild] });

    const row = await jobRow();
    expect(row.status).toBe("succeeded");
    expect(row.error).toBeNull();
    expect(row.results).toMatchObject({
      candidates: 1,
      planned: 1,
      claimed: 1,
      messages_sent: 1,
      reminders_sent: 1,
    });
    for (const value of Object.values(row.results)) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });

  it("combines an event's tasks into one message per event", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(3));
    await task(guild, first.eventId, dateOffset(1));
    await task(guild, second.eventId, dateOffset(3));

    await run({ guilds: [guild] });

    expect(sent.map((message) => message.threadId).sort()).toEqual(
      [first.threadId, second.threadId].sort(),
    );
  });

  it("does nothing for a task not yet due for a reminder", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(4));
    await run({ guilds: [guild] });
    expect(sent).toEqual([]);
    expect(await logRows(taskId)).toEqual([]);
  });

  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await run({ guilds: [] });
    expect(requests).toEqual([]);
    expect(await logRows(taskId)).toEqual([]);
    expect((await jobRow()).results).toMatchObject({ guilds_not_allowed: 1 });
  });

  it("logs a task the planner left out", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    const id = "00000000-0000-4000-8000-000000000001";
    planHook.invalidTaskIds = [id];
    await run({ guilds: [guild] });
    expect(logLines.join("\n")).toContain(id);
    expect((await jobRow()).results).toMatchObject({ invalid_tasks: 1 });
    expect(sent).toHaveLength(1);
  });
});

describe("a repeated run", () => {
  it("sends once when invoked twice in a row", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect((await run({ guilds: [guild] })).status).toBe("duplicate");

    expect(sent).toHaveLength(1);
  });

  // PGlite has one connection, so this shows only that overlapping runs share a lock
  // correctly. CI's two-connection job is what proves the lock under a real race.
  it("sends once when two runs overlap on one connection", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));

    const results = await Promise.all([
      run({ guilds: [guild] }),
      run({ guilds: [guild] }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "duplicate",
      "succeeded",
    ]);
    expect(sent).toHaveLength(1);
  });

  it("sends once even if the lock is lost, because claims still hold", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));

    await run({ guilds: [guild] });
    await database.exec(`DELETE FROM public.job_runs`);
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");

    expect(sent).toHaveLength(1);
  });

  it("makes no Discord request on a duplicate", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    await run({ guilds: [guild] });
    requests = [];
    await run({ guilds: [guild] });
    expect(requests).toEqual([]);
  });

  it("sends nothing the next day for what already went out", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    await run({ guilds: [guild] });
    await nextDay();
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect(sent).toHaveLength(1);
  });
});

describe("a crash between send and mark", () => {
  /** After the first send, every database request fails, as if the process died. */
  const crashAfterFirstSend = () => {
    let crashed = false;
    discordGate = (method) => {
      if (method === "POST") {
        crashed = true;
      }
      return undefined;
    };
    sqlGate = () => (crashed ? serverError("XX000") : undefined);
    return () => {
      crashed = false;
      discordGate = () => undefined;
      sqlGate = () => undefined;
    };
  };

  it("leaves the claim, then resends exactly once the next day", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));

    const restart = crashAfterFirstSend();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    restart();

    // The dead run's row is still 'running', and a fresh claim is left alone.
    expect((await run({ guilds: [guild] })).status).toBe("duplicate");
    expect(sent).toHaveLength(1);

    await nextDay();
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect(sent).toHaveLength(2);
    expect(await logRows(taskId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);

    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(2);
  });

  it("sends nothing before the claim has gone stale, and says it is waiting", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    const restart = crashAfterFirstSend();
    await run({ guilds: [guild] });
    restart();
    // Only the killed run is cleared: the claim is minutes old.
    await database.exec(
      `UPDATE public.job_runs SET heartbeat_at = now() - interval '1 hour', started_at = now() - interval '1 hour'`,
    );

    expect(await run({ guilds: [guild] })).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    expect(sent).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({ fresh_claims_waiting: 1 });
  });

  it("does not send a stale claim on a finished task", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    const restart = crashAfterFirstSend();
    await run({ guilds: [guild] });
    restart();
    await database.query(
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [taskId],
    );
    await nextDay();

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "skipped" }]);
    expect((await jobRow()).results).toMatchObject({ stale_closed: 1 });
  });
});

describe("reminders turned off during a run", () => {
  it("sends nothing further once the switch is off", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const third = await eventWithThread(guild);
    const taskIds = [
      await task(guild, first.eventId, dateOffset(3)),
      await task(guild, second.eventId, dateOffset(3)),
      await task(guild, third.eventId, dateOffset(3)),
    ];
    let off = false;
    discordGate = async (method) => {
      if (method === "POST" && !off) {
        off = true;
        await queryAs(
          database,
          "bot_app",
          `SELECT public.apply_config_change($1, 2, $1, false)`,
          [guild.guildId],
        );
      }
      return undefined;
    };

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    const states = await Promise.all(taskIds.map(logRows));
    expect(states.flat().map((row) => row.state)).toEqual(["sent"]);
    expect((await jobRow()).results).toMatchObject({ claim_lost: 2 });
  });

  it("sends nothing when off from the start", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_config_change($1, 2, $1, false)`,
      [guild.guildId],
    );
    await run({ guilds: [guild] });
    expect(requests).toEqual([]);
  });
});

describe("volume", () => {
  it("keeps 500 tasks on one person across 50 events under the cap", async () => {
    const guild = await guildInZone();
    const person = fakeId();
    const threads = new Set<string>();
    const taskIds: string[] = [];
    for (let event = 0; event < 50; event += 1) {
      const { eventId, threadId } = await eventWithThread(guild);
      threads.add(threadId);
      for (let index = 0; index < 10; index += 1) {
        taskIds.push(
          await task(
            guild,
            eventId,
            dateOffset(1),
            `Task ${String(index)}`,
            person,
          ),
        );
      }
    }
    expect(taskIds).toHaveLength(500);

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    // Two messages an event, as a message holds five tasks' buttons. That is the cap.
    expect(sent).toHaveLength(100);
    expect(new Set(sent.map((message) => message.threadId))).toEqual(threads);
    const pings = sent.filter((message) => message.users.includes(person));
    expect(pings).toHaveLength(20);
    for (const message of sent) {
      expect(message.content.length).toBeLessThanOrEqual(2000);
      expect(message.content).toContain(`<@${person}>`);
    }
    const { rows } = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM public.reminder_log WHERE state = 'sent'`,
    );
    expect(rows[0]?.count).toBe(500);
    expect((await jobRow()).results).toMatchObject({
      messages_sent: 100,
      reminders_sent: 500,
      pings_withheld: 80,
    });
  }, 120_000);

  it("gives each task a button, and spreads them when a message would hold too many", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskIds: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      taskIds.push(await task(guild, eventId, dateOffset(1), "Task"));
    }

    await run({ guilds: [guild] });

    expect(sent.map((message) => message.buttons.length)).toEqual([5, 2]);
    expect(sent.flatMap((message) => message.buttons).sort()).toEqual(
      taskIds.map((id) => `task.done:${id}`).sort(),
    );
  });

  it("gives a button only to a task it claimed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const claimedTask = await task(guild, eventId, dateOffset(1), "Keep");
    const stopped = await task(guild, eventId, dateOffset(1), "Stop");
    await database.query(
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [stopped],
    );

    await run({ guilds: [guild] });

    expect(sent.flatMap((message) => message.buttons)).toEqual([
      `task.done:${claimedTask}`,
    ]);
  });

  it("leaves what is over the cap unclaimed and records it", async () => {
    const guild = await guildInZone();
    const events = [
      await eventWithThread(guild),
      await eventWithThread(guild),
      await eventWithThread(guild),
    ];
    const taskIds: string[] = [];
    for (const { eventId } of events) {
      taskIds.push(await task(guild, eventId, dateOffset(3)));
    }

    const result = await run({ guilds: [guild], limits: { maxMessages: 2 } });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(2);
    expect((await jobRow()).results).toMatchObject({
      messages_sent: 2,
      deferred_cap: 1,
    });
    const states = await Promise.all(taskIds.map(logRows));
    expect(states.flat()).toHaveLength(2);

    // A same-day repeat must not send the remainder.
    expect((await run({ guilds: [guild] })).status).toBe("duplicate");
    expect(sent).toHaveLength(2);

    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(3);
  });

  it("still records skips after the cap stops the sends", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const taskIds = [
      await task(guild, first.eventId, todayUtc()),
      await task(guild, second.eventId, todayUtc()),
    ];
    await run({ guilds: [guild], limits: { maxMessages: 1 } });
    const rows = (await Promise.all(taskIds.map(logRows))).flat();
    expect(rows.filter((row) => row.state === "skipped")).toHaveLength(4);
    expect(rows.filter((row) => row.kind === "due_day")).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({
      skips_recorded: 4,
      deferred_cap: 1,
    });
  });

  it("leaves what is past the deadline unclaimed", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const firstTask = await task(guild, first.eventId, dateOffset(3));
    const secondTask = await task(guild, second.eventId, dateOffset(3));
    const start = Date.now();
    let elapsed = 0;
    discordGate = (method) => {
      if (method === "POST") {
        elapsed = 41_000;
      }
      return undefined;
    };

    const result = await run({
      guilds: [guild],
      now: () => new Date(start + elapsed),
    });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(sent).toHaveLength(1);
    const rows = [
      ...(await logRows(firstTask)),
      ...(await logRows(secondTask)),
    ];
    expect(rows.filter((row) => row.state === "sent")).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({ deferred_deadline: 1 });
  });

  it("alerts in job_runs when the read was truncated", async () => {
    const guild = await guildInZone();
    // Full pages, every one, of a closed event's task in a guild the run does not serve,
    // so the run reads to its page limit and plans nothing.
    const page = Array.from({ length: 500 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      event_id: "00000000-0000-4000-8000-000000000000",
      guild_id: fakeId(),
      assignee_id: fakeId(),
      description: "Book",
      due_date: "2030-01-10",
      status: "open",
      updated_at: "2030-01-01T00:00:00+00:00",
      event_name: "Social",
      thread_id: null,
      event_status: "closed",
      thread_status: "pending",
      thread_refusals: 0,
      timezone: "UTC",
      log: [],
    }));
    sqlGate = (call) => (names(call, "tasks") ? { rows: page } : undefined);
    const result = await run({ guilds: [guild] });
    expect(result.status).toBe("succeeded");
    expect((await jobRow()).results).toMatchObject({ truncated: 1 });
    expect(logLines.join("\n")).toContain("truncated");
    expect(logLines.length).toBeLessThanOrEqual(50);
  });
});

describe("long text", () => {
  it("delivers a 3,000-character event in several messages", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskIds = [
      await task(guild, eventId, dateOffset(3), `A${"a".repeat(999)}`),
      await task(guild, eventId, dateOffset(3), `B${"b".repeat(999)}`),
      await task(guild, eventId, dateOffset(3), `C${"c".repeat(999)}`),
    ];

    await run({ guilds: [guild] });

    expect(sent.length).toBeGreaterThan(1);
    const all = sent.map((message) => message.content).join("\n");
    expect(all).toContain("a".repeat(999));
    expect(all).toContain("b".repeat(999));
    expect(all).toContain("c".repeat(999));
    for (const message of sent) {
      expect(message.content.length).toBeLessThanOrEqual(2000);
    }
    const states = await Promise.all(taskIds.map(logRows));
    expect(states.flat().map((row) => row.state)).toEqual([
      "sent",
      "sent",
      "sent",
    ]);
  });

  it("puts the button only on the message where a split task ends", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const long = await task(guild, eventId, dateOffset(1), "_".repeat(1000));

    await run({ guilds: [guild] });

    expect(sent.length).toBeGreaterThanOrEqual(2);
    expect(sent.at(-1)?.buttons).toEqual([`task.done:${long}`]);
    for (const message of sent.slice(0, -1)) {
      expect(message.buttons).toEqual([]);
    }
  });

  it("splits one task whose escapes pass the limit and marks it once", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const assignee = fakeId();
    const long = await task(
      guild,
      eventId,
      dateOffset(3),
      "_".repeat(1000),
      assignee,
    );
    const short = await task(guild, eventId, dateOffset(3), "Short");

    await run({ guilds: [guild] });

    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(
      sent.filter((message) => message.users.includes(assignee)),
    ).toHaveLength(1);
    expect(await logRows(long)).toMatchObject([{ state: "sent" }]);
    expect(await logRows(short)).toMatchObject([{ state: "sent" }]);
  });
});

describe("one poisoned task", () => {
  const POISON = "forbiddenword";
  const refuseWord = () => {
    discordGate = (method, _path, message) =>
      method === "POST" && message?.content.includes(POISON)
        ? Response.json({ code: 200000 }, { status: 400 })
        : undefined;
  };

  it("does not block the others in its message or event", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const good = await task(guild, eventId, dateOffset(3), "Good one");
    const bad = await task(guild, eventId, dateOffset(3), POISON);
    const other = await task(guild, eventId, dateOffset(3), "Good two");
    refuseWord();

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(sent.map((message) => message.content).join()).not.toContain(POISON);
    expect(await logRows(good)).toMatchObject([{ state: "sent" }]);
    expect(await logRows(other)).toMatchObject([{ state: "sent" }]);
    expect(await logRows(bad)).toMatchObject([{ state: "skipped" }]);
    expect((await jobRow()).results).toMatchObject({
      items_refused: 1,
      batches_retried: 1,
      reminders_sent: 2,
    });
    expect(logLines.join("\n")).toContain(bad);
    expect(logLines.join("\n")).not.toContain(POISON);
  });

  it("does not block the next event, and is not retried daily", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(3), POISON);
    await task(guild, second.eventId, dateOffset(3), "Good");
    refuseWord();

    await run({ guilds: [guild] });
    expect(sent).toHaveLength(1);

    requests = [];
    await nextDay();
    await run({ guilds: [guild] });
    expect(posts()).toEqual([]);
  });

  it("stops at the task when its text cannot be split into messages", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const good = await task(guild, eventId, dateOffset(3), "Good");
    // One grapheme longer than a message. The length rule stops this today, so the
    // rule is lifted to show what happens if such a row ever exists.
    const oneGrapheme = Array.from({ length: 1500 }, () => "\u{1F469}").join(
      "\u200D",
    );
    await database.exec(
      `ALTER TABLE public.tasks DROP CONSTRAINT tasks_description_length`,
    );
    const bad = await task(guild, eventId, dateOffset(3), oneGrapheme);
    try {
      const result = await run({ guilds: [guild] });

      expect(result.status).toBe("succeeded");
      expect(sent).toHaveLength(1);
      expect(await logRows(good)).toMatchObject([{ state: "sent" }]);
      expect(await logRows(bad)).toEqual([]);
      expect((await jobRow()).results).toMatchObject({ render_failed: 1 });
    } finally {
      await database.query(`DELETE FROM public.tasks WHERE id = $1`, [bad]);
      await database.exec(
        `ALTER TABLE public.tasks ADD CONSTRAINT tasks_description_length
           CHECK (char_length(description) BETWEEN 1 AND 1000)`,
      );
    }
  });

  it("does not let an unexpected error in one event stop the next", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(3), POISON);
    await task(guild, second.eventId, dateOffset(3), "Good");
    refuseWord();
    let thrown = false;

    const result = await runReminders({
      db,
      client: discordClient(),
      allowedGuildIds: new Set([guild.guildId]),
      log: () => {
        thrown = true;
        throw new TypeError("logging failed");
      },
    });

    expect(thrown).toBe(true);
    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(sent).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({ event_errors: 1 });
  });

  it("sends a task with no visible text, with a stand-in", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const invisible = await task(guild, eventId, dateOffset(3), "​​");
    const good = await task(guild, eventId, dateOffset(3), "Good");

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).content).toContain("no readable description");
    expect(await logRows(invisible)).toMatchObject([{ state: "sent" }]);
    expect(await logRows(good)).toMatchObject([{ state: "sent" }]);
    expect((await jobRow()).results).toMatchObject({ render_stand_in: 1 });
  });
});

describe("the cap on refused sends", () => {
  it("counts refused sends, so text that is always refused cannot flood", async () => {
    const guild = await guildInZone();
    for (let event = 0; event < 4; event += 1) {
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, dateOffset(3), "first");
      await task(guild, eventId, dateOffset(3), "second");
    }
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 200000 }, { status: 400 })
        : undefined;

    const result = await run({ guilds: [guild], limits: { maxMessages: 5 } });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(posts()).toHaveLength(5);
    expect(sent).toEqual([]);
  });
});

describe("failures that stop the run", () => {
  it("stops on the first 401 after exactly one request", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const taskIds = [
      await task(guild, first.eventId, dateOffset(3)),
      await task(guild, second.eventId, dateOffset(3)),
    ];
    discordGate = () => Response.json({ code: 0 }, { status: 401 });

    const result = await run({ guilds: [guild] });

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      error: "discord_unauthorized:401",
    });
    const row = await jobRow();
    expect(row.status).toBe("failed");
    expect(row.error).toBe("discord_unauthorized:401");
    const claims = (await Promise.all(taskIds.map(logRows))).flat();
    expect(claims).toHaveLength(1);
    expect(row.results).toMatchObject({ deferred_halted: 1 });
  });

  it("stops on a global rate limit after exactly one request", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(3));
    await task(guild, second.eventId, dateOffset(3));
    discordGate = () =>
      Response.json(
        { retry_after: 1, global: true },
        { status: 429, headers: { "x-ratelimit-scope": "global" } },
      );

    const result = await run({ guilds: [guild] });

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      error: "discord_rate_limited:429",
    });
  });

  it("can run again after a failed run, once the token is fixed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    discordGate = () => Response.json({ code: 0 }, { status: 401 });
    await run({ guilds: [guild] });
    discordGate = () => undefined;
    // Not until the claim is stale: that is the rule for anything claimed and unsent.
    await database.exec(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");

    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "sent" }]);
  });

  it("stops claiming after repeated failures that may clear", async () => {
    const guild = await guildInZone();
    const taskIds: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { eventId } = await eventWithThread(guild);
      taskIds.push(await task(guild, eventId, dateOffset(3)));
    }
    discordGate = () => Response.json({ code: 0 }, { status: 503 });

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    expect((await jobRow()).results).toMatchObject({
      retry_later: 3,
      deferred_retrying: 3,
    });
    const states = await Promise.all(taskIds.map(logRows));
    expect(states.flat()).toHaveLength(3);
  });

  it("continues after one failure that may clear", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const failing = await task(guild, first.eventId, dateOffset(3));
    await task(guild, second.eventId, dateOffset(3));
    discordGate = (_method, path) =>
      path.startsWith(`/channels/${first.threadId}`)
        ? Response.json({ code: 0 }, { status: 503 })
        : undefined;

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(await logRows(failing)).toMatchObject([{ state: "claimed" }]);

    discordGate = () => undefined;
    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(2);
    expect(await logRows(failing)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
  });
});

describe("channels and threads that are gone", () => {
  const channelStatus = async (guild: GuildFixture) => {
    const { rows } = await database.query<{ status: string }>(
      `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
      [guild.guildId],
    );
    return rows[0]?.status;
  };
  const threadStatus = async (eventId: string) => {
    const { rows } = await database.query<{ thread_status: string }>(
      `SELECT thread_status FROM public.events WHERE id = $1`,
      [eventId],
    );
    return rows[0]?.thread_status;
  };
  const unknownChannel = () => Response.json({ code: 10003 }, { status: 404 });

  it("marks only the event when its thread is gone and the forum is not", async () => {
    const guild = await guildInZone();
    const gone = await eventWithThread(guild);
    const live = await eventWithThread(guild);
    await task(guild, gone.eventId, dateOffset(3));
    await task(guild, live.eventId, dateOffset(3));
    discordGate = (_method, path) =>
      path.startsWith(`/channels/${gone.threadId}`)
        ? unknownChannel()
        : path === `/channels/${guild.channelId}`
          ? Response.json({
              id: guild.channelId,
              type: 15,
              guild_id: guild.guildId,
            })
          : undefined;

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(await threadStatus(gone.eventId)).toBe("missing");
    expect(await channelStatus(guild)).toBe("active");
    expect(sent.map((message) => message.threadId)).toEqual([live.threadId]);
    expect((await jobRow()).results).toMatchObject({ threads_missing: 1 });
  });

  it("marks the forum, and skips its other events, only when a GET says it is gone", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const taskIds = [
      await task(guild, first.eventId, dateOffset(3)),
      await task(guild, second.eventId, dateOffset(3)),
    ];
    discordGate = () => unknownChannel();

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(await channelStatus(guild)).toBe("unavailable");
    expect(await threadStatus(first.eventId)).toBe("active");
    expect(await threadStatus(second.eventId)).toBe("active");
    expect(requests).toHaveLength(2);
    expect((await Promise.all(taskIds.map(logRows))).flat()).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({
      channels_gone: 1,
      claim_lost: 1,
    });
  });

  it("disables nothing on a 404 with no Discord code", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    discordGate = () => new Response("not found", { status: 404 });

    await run({ guilds: [guild] });

    expect(await channelStatus(guild)).toBe("active");
    expect(await threadStatus(eventId)).toBe("active");
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
  });

  it("disables nothing on a permissions failure, and asks only once", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    await task(guild, eventId, dateOffset(1));
    discordGate = () => Response.json({ code: 50001 }, { status: 403 });

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    // The thread, then its forum to see whether the refusal is only the thread's.
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(await channelStatus(guild)).toBe("active");
    expect(await threadStatus(eventId)).toBe("active");
    expect((await jobRow()).results).toMatchObject({
      channels_inaccessible: 1,
    });
  });

  it("stops if Discord refuses the token during the forum check", async () => {
    const guild = await guildInZone();
    const { eventId, threadId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    discordGate = (_method, path) =>
      path.startsWith(`/channels/${threadId}`)
        ? unknownChannel()
        : Response.json({ code: 0 }, { status: 401 });

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({ error: "discord_unauthorized:401" });
    expect(await channelStatus(guild)).toBe("active");
    expect(await threadStatus(eventId)).toBe("active");
  });
});

describe("a thread whose parent is not managed", () => {
  it("sends nothing, keeps the claim and leaves it to be retried", async () => {
    const guild = await guildInZone();
    const { eventId, threadId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    threadParents.set(threadId, { guildId: guild.guildId, parentId: fakeId() });

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(posts()).toEqual([]);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    expect((await jobRow()).results).toMatchObject({ retry_later: 1 });
  });
});

describe("responses that do not blame the text", () => {
  const LOCKED = 160005;
  const CLOUDFLARE = 40333;

  it.each<[string, number, string]>([
    ["a proxy's HTML 403", 403, "<html>blocked</html>"],
    ["a 404 with no code", 404, "nf"],
    ["a 400 with no code", 400, "bad"],
    ["a locked thread", 403, JSON.stringify({ code: LOCKED })],
    ["a locked thread as a 400", 400, JSON.stringify({ code: LOCKED })],
    ["Cloudflare", 403, JSON.stringify({ code: CLOUDFLARE })],
    ["a timeout", 408, "t"],
    ["a conflict", 409, "c"],
    ["too large", 413, "big"],
    [
      "AutoMod's code on the wrong status",
      403,
      JSON.stringify({ code: 200000 }),
    ],
  ])("keeps the reminder after %s", async (_label, status, body) => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    discordGate = () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(await logRows(taskId)).toMatchObject([
      { state: "claimed", attempts: 1 },
    ]);

    discordGate = () => undefined;
    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
  });

  it.each([200000, 240000, 50035])(
    "skips the item when a 400 carries text code %i",
    async (code) => {
      const guild = await guildInZone();
      const { eventId } = await eventWithThread(guild);
      const taskId = await task(guild, eventId, dateOffset(3));
      discordGate = (method) =>
        method === "POST"
          ? Response.json({ code }, { status: 400 })
          : undefined;
      const result = await run({ guilds: [guild] });
      expect(result.status).toBe("succeeded");
      expect(await logRows(taskId)).toMatchObject([{ state: "skipped" }]);
    },
  );
});

describe("a failed morning and the recovery cron", () => {
  it("does not read an outage as success, and recovers the same day", async () => {
    const guild = await guildInZone();
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const { eventId } = await eventWithThread(guild);
      ids.push(await task(guild, eventId, dateOffset(3)));
    }
    discordGate = () => new Response("bad gateway", { status: 502 });

    const morning = await run({ guilds: [guild] });

    expect(morning).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    // What the health check's freshness alert reads.
    expect(
      await getLatestSucceededJobRun(db, { jobName: "reminders" }),
    ).toEqual({ ok: true, value: null });

    // The 17:00 cron, by which time a morning claim has gone stale.
    discordGate = () => undefined;
    await database.exec(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );
    const recovery = await run({ guilds: [guild] });

    expect(recovery.status).toBe("succeeded");
    expect(sent).toHaveLength(5);
    expect(
      await getLatestSucceededJobRun(db, { jobName: "reminders" }),
    ).toMatchObject({
      ok: true,
      value: { job_name: "reminders", status: "succeeded" },
    });
  });

  it("makes the recovery cron a no-op after a good morning", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    requests = [];
    const recovery = await run({ guilds: [guild] });
    expect(recovery.status).toBe("duplicate");
    expect(requests).toEqual([]);
  });

  it("counts a run stopped by the message cap as a success", async () => {
    const guild = await guildInZone();
    for (let index = 0; index < 3; index += 1) {
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, dateOffset(3));
    }
    const result = await run({ guilds: [guild], limits: { maxMessages: 1 } });
    expect(result.status).toBe("succeeded");
  });

  it("does not read refused claims as success", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    sqlGate = (call) =>
      names(call, "claim_reminder") ? unavailable() : undefined;
    expect(await run({ guilds: [guild] })).toMatchObject({
      error: "reminders_incomplete",
    });
  });

  it("does not let a failed run's retry notify someone afresh", async () => {
    const guild = await guildInZone();
    const person = fakeId();
    for (let index = 0; index < 6; index += 1) {
      const { eventId } = await eventWithThread(guild);
      await task(
        guild,
        eventId,
        dateOffset(3),
        `Task ${String(index)}`,
        person,
      );
    }
    let count = 0;
    discordGate = (method) => {
      count += method === "POST" ? 1 : 0;
      return method === "POST" && count === 3
        ? Response.json(
            { global: true, retry_after: 1 },
            { status: 429, headers: { "x-ratelimit-scope": "global" } },
          )
        : undefined;
    };
    const limits = { maxPingsPerPerson: 2 };

    expect((await run({ guilds: [guild], limits })).status).toBe("failed");
    // Still failed, because the send that was refused holds a claim too recent to retake.
    expect((await run({ guilds: [guild], limits })).status).toBe("failed");

    expect(sent.length).toBeGreaterThan(2);
    expect(
      sent.filter((message) => message.users.includes(person)),
    ).toHaveLength(2);
  });
});

describe("a rerun soon after a failed run", () => {
  it.each<[string, number, string]>([
    ["due today", 0, "due_day"],
    ["due tomorrow", 1, "one_day"],
  ])(
    "leaves the slot open for the recovery cron, for a task %s",
    async (_label, days, kind) => {
      const guild = await guildInZone();
      const { eventId, threadId } = await eventWithThread(guild);
      const person = fakeId();
      const taskId = await task(
        guild,
        eventId,
        dateOffset(days),
        "Book",
        person,
      );

      // The morning cron fails.
      discordGate = (method) =>
        method === "POST"
          ? new Response("unavailable", { status: 503 })
          : undefined;
      expect((await run({ guilds: [guild] })).status).toBe("failed");
      expect(sent).toEqual([]);

      // A second delivery or a by-hand run, with Discord working again.
      discordGate = () => undefined;
      expect(await run({ guilds: [guild] })).toMatchObject({
        status: "failed",
        error: "reminders_incomplete",
      });
      expect(sent).toEqual([]);
      expect((await jobRow()).results).toMatchObject({
        fresh_claims_waiting: 1,
      });
      expect(
        await getLatestSucceededJobRun(db, { jobName: "reminders" }),
      ).toEqual({ ok: true, value: null });

      // The 17:00 cron, by which time the morning's claim has gone stale.
      await database.exec(
        `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
      );
      const recovery = await run({ guilds: [guild] });

      expect(recovery.status).toBe("succeeded");
      expect(sent.map((message) => message.threadId)).toEqual([threadId]);
      expect(present(sent[0]).users).toEqual([person]);
      expect(await logRows(taskId)).toContainEqual(
        expect.objectContaining({ kind, state: "sent" }),
      );
      expect(
        await getLatestSucceededJobRun(db, { jobName: "reminders" }),
      ).toMatchObject({ ok: true, value: { status: "succeeded" } });
    },
  );

  it("still sends what the failed run did not reach", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(0));
    await task(guild, second.eventId, dateOffset(1));
    discordGate = (_method, path) =>
      path.includes(first.threadId)
        ? new Response("unavailable", { status: 503 })
        : undefined;
    await run({ guilds: [guild] });
    expect(sent.map((message) => message.threadId)).toEqual([second.threadId]);

    discordGate = () => undefined;
    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect(sent).toHaveLength(1);
  });

  it("does not fail on the fresh claim of a kind a newer reminder has replaced", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(0));
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'one_day', $2)`,
      [taskId, dateOffset(0)],
    );

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect(sent).toHaveLength(1);
  });
});

describe("what counts as a send that may have landed", () => {
  const overdueFor = async (guild: GuildFixture, person: string) => {
    const { eventId, threadId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(-5), "Book", person);
    return { eventId, threadId, taskId };
  };

  const REFUSALS: [string, () => Response][] = [
    [
      "a missing permission",
      () => Response.json({ code: 50013 }, { status: 403 }),
    ],
    ["a missing access", () => Response.json({ code: 50001 }, { status: 403 })],
    ["a locked post", () => Response.json({ code: 160005 }, { status: 400 })],
    [
      "a proxy's refusal",
      () => Response.json({ code: 40333 }, { status: 403 }),
    ],
    [
      "a shared rate limit",
      () =>
        Response.json(
          { retry_after: 1000 },
          { status: 429, headers: { "x-ratelimit-scope": "shared" } },
        ),
    ],
  ];

  it.each(REFUSALS)(
    "still pings after two runs refused with %s",
    async (_label, refusal) => {
      const guild = await guildInZone();
      const person = fakeId();
      const { taskId } = await overdueFor(guild, person);

      discordGate = (method) => (method === "POST" ? refusal() : undefined);
      await run({ guilds: [guild] });
      await nextDay();
      await run({ guilds: [guild] });
      await nextDay();
      discordGate = () => undefined;
      await run({ guilds: [guild] });

      expect(sent).toHaveLength(1);
      expect(present(sent[0]).users).toEqual([person]);
      expect(
        await logRows(taskId).then((rows) =>
          rows.filter((row) => row.kind === "overdue"),
        ),
      ).toMatchObject([{ state: "sent", attempts: 3 }]);
      expect(await refusedAttempts(taskId, "overdue")).toBe(2);
    },
  );

  it.each<[string, () => Response | never]>([
    ["a server error", () => new Response("bad", { status: 503 })],
    ["a reply it could not read", () => new Response("not json")],
    [
      "a lost response",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])(
    "withholds the ping after two runs ending in %s",
    async (_label, answer) => {
      const guild = await guildInZone();
      const person = fakeId();
      const { taskId } = await overdueFor(guild, person);

      discordGate = (method) => (method === "POST" ? answer() : undefined);
      await run({ guilds: [guild] });
      await nextDay();
      await run({ guilds: [guild] });
      await nextDay();
      discordGate = () => undefined;
      await run({ guilds: [guild] });

      expect(sent).toHaveLength(1);
      expect(present(sent[0]).users).toEqual([]);
      expect(await refusedAttempts(taskId, "overdue")).toBe(0);
    },
  );

  it("counts a claim left by a crash as a send that may have landed", async () => {
    const guild = await guildInZone();
    const person = fakeId();
    const { taskId } = await overdueFor(guild, person);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'overdue', $2)`,
      [taskId, dateOffset(-5)],
    );
    await database.query(
      `UPDATE public.reminder_log SET attempts = 2, claimed_at = now() - interval '2 hours'`,
    );

    await run({ guilds: [guild] });

    expect(present(sent[0]).users).toEqual([]);
  });

  it("does not count a refused later part as not sent, since an earlier part landed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3), "_".repeat(1000));
    let posted = 0;
    discordGate = (method) => {
      posted += method === "POST" ? 1 : 0;
      return method === "POST" && posted === 2
        ? Response.json({ code: 50013 }, { status: 403 })
        : undefined;
    };

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(await refusedAttempts(taskId, "three_days")).toBe(0);
  });

  it("records a reminder left unsent after its batch's text was refused", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskIds = [
      await task(guild, eventId, dateOffset(3), "First"),
      await task(guild, eventId, dateOffset(3), "Second"),
    ];
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50035 }, { status: 400 })
        : undefined;

    await run({ guilds: [guild], limits: { maxMessages: 1 } });

    const refused = await Promise.all(
      taskIds.map((id) => refusedAttempts(id, "three_days")),
    );
    expect(refused).toEqual([1, 1]);
  });

  it("records what was not tried after a batch's text was refused and a lone send failed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const first = await task(guild, eventId, dateOffset(3), "First");
    const second = await task(guild, eventId, dateOffset(3), "Second");
    let posted = 0;
    discordGate = (method) => {
      if (method !== "POST") {
        return undefined;
      }
      posted += 1;
      return posted === 1
        ? Response.json({ code: 50035 }, { status: 400 })
        : new Response("bad", { status: 503 });
    };

    await run({ guilds: [guild] });

    expect(posted).toBe(2);
    // The lone send may have landed. The one after it was never tried.
    const refused = await Promise.all(
      [first, second].map((id) => refusedAttempts(id, "three_days")),
    );
    expect(refused.toSorted()).toEqual([0, 1]);
  });

  it("says so if a refusal could not be recorded, and still pings later if it could", async () => {
    const guild = await guildInZone();
    const person = fakeId();
    await overdueFor(guild, person);
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50013 }, { status: 403 })
        : undefined;
    sqlGate = (call) =>
      names(call, "record_reminder_refused") ? unavailable() : undefined;

    await run({ guilds: [guild] });

    expect((await jobRow()).results).toMatchObject({
      refusals_not_recorded: 1,
    });
  });
});

describe("a thread that refuses the bot", () => {
  const thread = async (guild: GuildFixture, days = 3, person = fakeId()) => {
    const made = await eventWithThread(guild);
    const taskId = await task(
      guild,
      made.eventId,
      dateOffset(days),
      "Book",
      person,
    );
    return { ...made, taskId, person };
  };
  const refusalsOf = async (eventId: string) => {
    const { rows } = await database.query<{ thread_refusals: number }>(
      `SELECT thread_refusals FROM public.events WHERE id = $1`,
      [eventId],
    );
    return present(rows[0]).thread_refusals;
  };
  /** Runs daily with the given refusal until the reminder is held. */
  const untilHeld = async (guild: GuildFixture, answer: () => Response) => {
    const outcomes: string[] = [];
    for (let index = 0; index < THREAD_REFUSALS_BEFORE_HOLD; index += 1) {
      discordGate = (method) => (method === "POST" ? answer() : undefined);
      outcomes.push(
        (await run({ guilds: [guild] })).status === "duplicate"
          ? "duplicate"
          : (await jobRow()).status,
      );
      await nextDay();
    }
    return outcomes;
  };
  const CODES: [string, () => Response][] = [
    ["50001", () => Response.json({ code: 50001 }, { status: 403 })],
    ["50013", () => Response.json({ code: 50013 }, { status: 403 })],
    ["160005 as a 400", () => Response.json({ code: 160005 }, { status: 400 })],
    ["160005 as a 403", () => Response.json({ code: 160005 }, { status: 403 })],
  ];

  it.each(CODES)(
    "fails the job only up to the limit, then holds it, for %s",
    async (_label, answer) => {
      const guild = await guildInZone();
      const blocked = await thread(guild);

      expect(await untilHeld(guild, answer)).toEqual([
        "failed",
        "failed",
        "succeeded",
      ]);

      const { results } = await jobRow();
      expect(results).toMatchObject({
        threads_held: 1,
        held_reminders: 1,
        held_event_ids: [blocked.eventId],
      });
      expect(logLines.join("\n")).toContain(blocked.eventId);
      // Held, and neither skipped nor lost.
      expect(await logRows(blocked.taskId)).toMatchObject([
        { kind: "three_days", state: "claimed" },
      ]);
      expect(
        await getLatestSucceededJobRun(db, { jobName: "reminders" }),
      ).toMatchObject({ ok: true, value: { status: "succeeded" } });
    },
  );

  it("names the event in the log from the first refusal", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50001 }, { status: 403 })
        : undefined;
    await run({ guilds: [guild] });
    expect(logLines.join("\n")).toContain(blocked.eventId);
  });

  it("sends the held reminder with its ping once the thread takes messages", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    await untilHeld(guild, () =>
      Response.json({ code: 160005 }, { status: 400 }),
    );
    expect(await refusalsOf(blocked.eventId)).toBe(THREAD_REFUSALS_BEFORE_HOLD);

    discordGate = () => undefined;
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).users).toEqual([blocked.person]);
    expect(await logRows(blocked.taskId)).toMatchObject([
      { kind: "three_days", state: "sent", attempts: 4 },
    ]);
    expect(await refusalsOf(blocked.eventId)).toBe(0);
    expect((await jobRow()).results).not.toHaveProperty("held_event_ids");
  });

  it("starts counting again after a send lands", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    await task(guild, blocked.eventId, dateOffset(3), "Other");
    await untilHeld(guild, () =>
      Response.json({ code: 50013 }, { status: 403 }),
    );
    discordGate = () => undefined;
    await run({ guilds: [guild] });
    await nextDay();

    await task(guild, blocked.eventId, dateOffset(3), "New task");
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50013 }, { status: 403 })
        : undefined;

    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect(await refusalsOf(blocked.eventId)).toBe(1);
  });

  it("stays held when its task moves on to the next kind of reminder", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild, 3);
    await untilHeld(guild, () =>
      Response.json({ code: 50001 }, { status: 403 }),
    );

    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50001 }, { status: 403 })
        : undefined;
    const later = new Date(Date.now() + 2 * 86_400_000);
    const result = await run({ guilds: [guild], now: () => later });

    expect(result.status).toBe("succeeded");
    expect(await logRows(blocked.taskId)).toContainEqual(
      expect.objectContaining({ kind: "one_day", state: "claimed" }),
    );
  });

  it("does not fail a rerun on a held reminder's fresh claim", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    await untilHeld(guild, () =>
      Response.json({ code: 50001 }, { status: 403 }),
    );
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50001 }, { status: 403 })
        : undefined;
    await run({ guilds: [guild] });
    // A new slot, with the claim still minutes old.
    await database.exec(
      `UPDATE public.job_runs
       SET started_at = started_at - interval '25 hours',
           heartbeat_at = heartbeat_at - interval '25 hours'`,
    );

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect((await jobRow()).results).toMatchObject({
      held_event_ids: [blocked.eventId],
    });
    expect((await jobRow()).results).not.toHaveProperty("fresh_claims_waiting");
  });

  it("does not let other events wait on three locked posts", async () => {
    const guild = await guildInZone();
    const locked = [
      await thread(guild, 1),
      await thread(guild, 1),
      await thread(guild, 1),
    ];
    const healthy = await thread(guild, 3);
    const lockedIds = new Set(locked.map((each) => each.threadId));
    discordGate = (method, path) =>
      method === "POST" &&
      lockedIds.has(/^\/channels\/([0-9]+)/.exec(path)?.[1] ?? "")
        ? Response.json({ code: 160005 }, { status: 400 })
        : undefined;

    await run({ guilds: [guild] });

    expect(sent.map((message) => message.threadId)).toEqual([healthy.threadId]);
  });

  it("leaves an event already refusing behind ones that are not", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild, 1);
    await database.query(
      `UPDATE public.events SET thread_refusals = 1 WHERE id = $1`,
      [blocked.eventId],
    );
    const healthy = await thread(guild, 3);

    await run({ guilds: [guild] });

    expect(sent.map((message) => message.threadId)).toEqual([
      healthy.threadId,
      blocked.threadId,
    ]);
  });

  it("caps the IDs a run's row holds, and still counts them all", async () => {
    const guild = await guildInZone();
    for (let index = 0; index < 30; index += 1) {
      const { eventId } = await thread(guild);
      await database.query(
        `UPDATE public.events SET thread_refusals = $2 WHERE id = $1`,
        [eventId, THREAD_REFUSALS_BEFORE_HOLD],
      );
    }
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50001 }, { status: 403 })
        : undefined;

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");

    const { results } = await jobRow();
    expect(results.threads_held).toBe(30);
    expect(results.held_event_ids).toHaveLength(25);
  });

  it("stays failed for what else went wrong in the run", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    await database.query(
      `UPDATE public.events SET thread_refusals = $2 WHERE id = $1`,
      [blocked.eventId, THREAD_REFUSALS_BEFORE_HOLD],
    );
    const other = await thread(guild);
    discordGate = (method, path) =>
      method !== "POST"
        ? undefined
        : path.includes(blocked.threadId)
          ? Response.json({ code: 50001 }, { status: 403 })
          : path.includes(other.threadId)
            ? new Response("bad", { status: 503 })
            : undefined;

    expect(await run({ guilds: [guild] })).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
  });

  it("stays failed if the refusal cannot be recorded", async () => {
    const guild = await guildInZone();
    await thread(guild);
    discordGate = (method) =>
      method === "POST"
        ? Response.json({ code: 50001 }, { status: 403 })
        : undefined;
    sqlGate = (call) =>
      names(call, "record_thread_refusal") ? unavailable() : undefined;

    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect((await jobRow()).results).toMatchObject({ thread_check_failed: 1 });
  });

  it("does not hold a thread failing for a reason that says nothing about it", async () => {
    const guild = await guildInZone();
    const blocked = await thread(guild);
    await database.query(
      `UPDATE public.events SET thread_refusals = $2 WHERE id = $1`,
      [blocked.eventId, THREAD_REFUSALS_BEFORE_HOLD],
    );
    discordGate = (method) =>
      method === "POST" ? new Response("bad", { status: 503 }) : undefined;

    expect((await run({ guilds: [guild] })).status).toBe("failed");
  });
});

describe("the bot removed from the server", () => {
  const removed = () => Response.json({ code: 50001 }, { status: 403 });
  const makeWorld = async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    const person = fakeId();
    const taskIds = [
      await task(guild, first.eventId, dateOffset(3), "One", person),
      await task(guild, second.eventId, dateOffset(3), "Two", person),
    ];
    return { guild, first, second, person, taskIds };
  };
  const channelStatus = async (guild: GuildFixture) => {
    const { rows } = await database.query<{ status: string }>(
      `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
      [guild.guildId],
    );
    return rows[0]?.status;
  };

  /** Runs daily, for longer than a thread takes to be held, and returns each run's status. */
  const dailyStatuses = async (guild: GuildFixture) => {
    const statuses: unknown[] = [];
    for (let index = 0; index <= THREAD_REFUSALS_BEFORE_HOLD + 1; index += 1) {
      await run({ guilds: [guild] });
      statuses.push((await jobRow()).status);
      await nextDay();
    }
    return statuses;
  };
  const refusalCounts = async (eventIds: readonly string[]) => {
    const { rows } = await database.query<{ thread_refusals: number }>(
      `SELECT thread_refusals FROM public.events WHERE id = ANY($1)`,
      [eventIds],
    );
    return rows.map((row) => row.thread_refusals);
  };

  it("keeps failing, without holding, when every channel answers 50001", async () => {
    const { guild, first, second, person, taskIds } = await makeWorld();
    discordGate = () => removed();

    expect(new Set(await dailyStatuses(guild))).toEqual(new Set(["failed"]));

    const { results } = await jobRow();
    expect(results).toMatchObject({ channels_inaccessible: 2 });
    expect(results).not.toHaveProperty("threads_held");
    expect(results).not.toHaveProperty("held_event_ids");
    expect(
      await getLatestSucceededJobRun(db, { jobName: "reminders" }),
    ).toMatchObject({ ok: true, value: null });
    expect(await refusalCounts([first.eventId, second.eventId])).toEqual([
      0, 0,
    ]);
    expect(await channelStatus(guild)).toBe("active");
    expect(sent).toEqual([]);

    // Added back, and what waited goes out with its ping.
    discordGate = () => undefined;
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect(sent).toHaveLength(2);
    expect(sent.every((message) => message.users.includes(person))).toBe(true);
    expect((await Promise.all(taskIds.map(logRows))).flat()).toMatchObject([
      { state: "sent" },
      { state: "sent" },
    ]);
  });

  it("keeps failing too when the refusal is Unknown Guild", async () => {
    const { guild } = await makeWorld();
    discordGate = () => Response.json({ code: 10004 }, { status: 404 });

    expect(new Set(await dailyStatuses(guild))).toEqual(new Set(["failed"]));
    expect((await jobRow()).results).not.toHaveProperty("threads_held");
  });

  it("keeps failing too when a thread answers Unknown Channel and the forum 50001", async () => {
    const { guild, first, second } = await makeWorld();
    discordGate = (_method, path) =>
      path === `/channels/${guild.channelId}`
        ? removed()
        : Response.json({ code: 10003 }, { status: 404 });

    expect(new Set(await dailyStatuses(guild))).toEqual(new Set(["failed"]));

    expect((await jobRow()).results).not.toHaveProperty("threads_held");
    expect(await channelStatus(guild)).toBe("active");
    const { rows } = await database.query<{ thread_status: string }>(
      `SELECT thread_status FROM public.events WHERE id = ANY($1)`,
      [[first.eventId, second.eventId]],
    );
    expect(rows).toEqual([
      { thread_status: "active" },
      { thread_status: "active" },
    ]);
  });

  it("does not let a rerun pass on an event held before the bot was removed", async () => {
    const { guild, first, second } = await makeWorld();
    await database.query(
      `UPDATE public.events SET thread_refusals = $2 WHERE id = ANY($1)`,
      [[first.eventId, second.eventId], THREAD_REFUSALS_BEFORE_HOLD],
    );
    discordGate = () => removed();

    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect(await refusalCounts([first.eventId, second.eventId])).toEqual([
      0, 0,
    ]);
    // A new slot, with the claims still minutes old, as at the recovery cron.
    await database.exec(
      `UPDATE public.job_runs
       SET started_at = started_at - interval '25 hours',
           heartbeat_at = heartbeat_at - interval '25 hours'`,
    );

    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect((await jobRow()).results).toMatchObject({ fresh_claims_waiting: 2 });
  });

  it("does not hold when the forum check cannot say", async () => {
    const { guild } = await makeWorld();
    discordGate = (method, path) =>
      method === "GET" && path === `/channels/${guild.channelId}`
        ? new Response("bad", { status: 503 })
        : method === "POST"
          ? removed()
          : undefined;

    expect(new Set(await dailyStatuses(guild))).toEqual(new Set(["failed"]));
    expect((await jobRow()).results).toMatchObject({ thread_check_failed: 2 });
    expect((await jobRow()).results).not.toHaveProperty("threads_held");
  });

  it("still holds a thread whose forum the bot can read", async () => {
    const { guild, first, second } = await makeWorld();
    discordGate = (method, path) =>
      method === "POST" && path.includes(first.threadId)
        ? removed()
        : undefined;

    const statuses = [];
    for (let index = 0; index < THREAD_REFUSALS_BEFORE_HOLD; index += 1) {
      await run({ guilds: [guild] });
      statuses.push((await jobRow()).status);
      await nextDay();
    }

    expect(statuses).toEqual(["failed", "failed", "succeeded"]);
    expect((await jobRow()).results).toMatchObject({
      held_event_ids: [first.eventId],
    });
    expect(sent.map((message) => message.threadId)).toEqual([second.threadId]);
  });
});

describe("an event whose post has gone", () => {
  const unknownChannel = () => Response.json({ code: 10003 }, { status: 404 });

  it("names it in the log and the run's row, on the day and every day after", async () => {
    const guild = await guildInZone();
    const gone = await eventWithThread(guild);
    await task(guild, gone.eventId, dateOffset(3));
    discordGate = (_method, path) =>
      path.startsWith(`/channels/${gone.threadId}`)
        ? unknownChannel()
        : path === `/channels/${guild.channelId}`
          ? Response.json({
              id: guild.channelId,
              type: 15,
              guild_id: guild.guildId,
            })
          : undefined;

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect((await jobRow()).results).toMatchObject({
      threads_missing: 1,
      missing_event_ids: [gone.eventId],
    });
    expect(logLines.join("\n")).toContain(gone.eventId);

    logLines = [];
    await nextDay();
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    expect((await jobRow()).results).toMatchObject({
      events_stopped: 1,
      missing_event_ids: [gone.eventId],
    });
    expect(logLines.join("\n")).toContain(gone.eventId);
    expect(sent).toEqual([]);
  });
});

describe("a task changed after the run read it", () => {
  const twoEvents = async (changed: string) => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(1), "Sent first");
    const taskId = await task(
      guild,
      second.eventId,
      dateOffset(3),
      "Old text",
      changed,
    );
    return { guild, first, second, taskId };
  };

  it("does not ping the old assignee, and the recovery cron pings the new one", async () => {
    const before = fakeId();
    const after = fakeId();
    const { guild, second, taskId } = await twoEvents(before);
    let changed = false;
    discordGate = async (method) => {
      if (method === "POST" && !changed) {
        changed = true;
        await database.query(
          `UPDATE public.tasks SET assignee_id = $2, description = 'New text' WHERE id = $1`,
          [taskId, after],
        );
      }
      return undefined;
    };

    expect(await run({ guilds: [guild] })).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    expect((await jobRow()).results).toMatchObject({ claim_outdated: 1 });
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toEqual([]);

    const recovery = await run({ guilds: [guild] });

    expect(recovery.status).toBe("succeeded");
    const last = present(sent.at(-1));
    expect(last.threadId).toBe(second.threadId);
    expect(last.users).toEqual([after]);
    expect(last.content).toContain("New text");
  });

  it("does the same when taking over a stale claim", async () => {
    const before = fakeId();
    const after = fakeId();
    const { guild, taskId } = await twoEvents(before);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'three_days', $2)`,
      [taskId, dateOffset(3)],
    );
    await database.query(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );
    let changed = false;
    discordGate = async (method) => {
      if (method === "POST" && !changed) {
        changed = true;
        await database.query(
          `UPDATE public.tasks SET assignee_id = $2 WHERE id = $1`,
          [taskId, after],
        );
      }
      return undefined;
    };

    expect((await run({ guilds: [guild] })).status).toBe("failed");
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([
      { state: "claimed", attempts: 1 },
    ]);
  });
});

describe("the message cap", () => {
  it("logs what it left for later, though the run succeeds", async () => {
    const guild = await guildInZone();
    for (let index = 0; index < 3; index += 1) {
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, dateOffset(3));
    }

    const result = await run({ guilds: [guild], limits: { maxMessages: 1 } });

    expect(result.status).toBe("succeeded");
    expect((await jobRow()).results).toMatchObject({ deferred_cap: 2 });
    expect(logLines.join("\n")).toContain("message cap");
  });
});

describe("the per-person limit across days", () => {
  it("does not count what went out before this slot", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const person = fakeId();
    await task(guild, eventId, dateOffset(3), "Earlier", person);
    await run({ guilds: [guild] });
    await nextDay();
    await task(guild, eventId, dateOffset(3), "Later", person);

    await run({ guilds: [guild], limits: { maxPingsPerPerson: 1 } });

    expect(sent).toHaveLength(2);
    expect(present(sent[1]).users).toEqual([person]);
  });
});

describe("guilds that fail, and guilds that are busy", () => {
  const failPostsTo = (threads: readonly string[]) => {
    discordGate = (method, path) =>
      method === "POST" && threads.some((thread) => path.includes(thread))
        ? new Response("oops", { status: 500 })
        : undefined;
  };

  it("does not let three failing events in one guild block another", async () => {
    const failing = await guildInZone();
    const healthy = await guildInZone();
    const threads: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const { eventId, threadId } = await eventWithThread(failing);
      threads.push(threadId);
      await task(failing, eventId, dateOffset(-5));
    }
    const good = await eventWithThread(healthy);
    const goodTask = await task(healthy, good.eventId, dateOffset(-1));
    failPostsTo(threads);

    const result = await run({ guilds: [failing, healthy] });

    expect(sent.map((message) => message.threadId)).toEqual([good.threadId]);
    expect(
      (await logRows(goodTask)).find((row) => row.kind === "overdue"),
    ).toMatchObject({ state: "sent" });
    expect(posts().length).toBe(4);
    expect(result).toMatchObject({ error: "reminders_incomplete" });
  });

  it("resets the count of failures on a success", async () => {
    const guild = await guildInZone();
    const events: Awaited<ReturnType<typeof eventWithThread>>[] = [];
    for (let index = 0; index < 5; index += 1) {
      const event = await eventWithThread(guild);
      events.push(event);
      // Earliest due goes first, so this fixes the order: fail, fail, ok, fail, fail.
      await task(guild, event.eventId, dateOffset(index - 8));
    }
    failPostsTo([0, 1, 3, 4].map((index) => present(events[index]).threadId));

    await run({ guilds: [guild] });

    expect(posts()).toHaveLength(5);
    expect(sent.map((message) => message.threadId)).toEqual([
      present(events[2]).threadId,
    ]);
    const { results } = await jobRow();
    expect(results).toMatchObject({ retry_later: 4 });
    expect(results.deferred_retrying).toBeUndefined();
  });

  it("sends events holding a stale claim after fresh ones", async () => {
    const guild = await guildInZone();
    const stale = await eventWithThread(guild);
    const fresh = await eventWithThread(guild);
    const staleTask = await task(guild, stale.eventId, dateOffset(-3));
    await task(guild, fresh.eventId, dateOffset(3));
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'overdue', $2)`,
      [staleTask, dateOffset(-3)],
    );
    await database.exec(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );

    await run({ guilds: [guild] });

    expect(sent.map((message) => message.threadId)).toEqual([
      fresh.threadId,
      stale.threadId,
    ]);
  });

  it("takes turns across guilds, so a busy guild shares the cap", async () => {
    const busy = await guildInZone();
    const quiet = await guildInZone();
    for (let index = 0; index < 5; index += 1) {
      const { eventId } = await eventWithThread(busy);
      await task(busy, eventId, dateOffset(-5));
    }
    const lone = await eventWithThread(quiet);
    await task(quiet, lone.eventId, dateOffset(3));

    const result = await run({
      guilds: [busy, quiet],
      limits: { maxMessages: 2 },
    });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(2);
    expect(sent.map((message) => message.threadId)).toContain(lone.threadId);
    expect((await jobRow()).results).toMatchObject({ deferred_cap: 4 });
  });

  it("lets a guild use what another guild has no need for", async () => {
    const busy = await guildInZone();
    const quiet = await guildInZone();
    for (let index = 0; index < 5; index += 1) {
      const { eventId } = await eventWithThread(busy);
      await task(busy, eventId, dateOffset(3));
    }
    const lone = await eventWithThread(quiet);
    await task(quiet, lone.eventId, dateOffset(3));
    await run({ guilds: [busy, quiet], limits: { maxMessages: 4 } });
    expect(sent).toHaveLength(4);
  });

  it("counts pings per guild, so one person's limit is not shared", async () => {
    const one = await guildInZone();
    const two = await guildInZone();
    const person = fakeId();
    for (const guild of [one, two]) {
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, dateOffset(3), "Book", person);
    }
    await run({ guilds: [one, two], limits: { maxPingsPerPerson: 1 } });
    expect(
      sent.filter((message) => message.users.includes(person)),
    ).toHaveLength(2);
  });
});

describe("repeated attempts", () => {
  it("sends without the ping from the third attempt, and logs the task", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const person = fakeId();
    const taskId = await task(guild, eventId, dateOffset(3), "Book", person);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'three_days', $2)`,
      [taskId, dateOffset(3)],
    );
    await database.query(
      `UPDATE public.reminder_log SET attempts = 2, claimed_at = now() - interval '2 hours'`,
    );

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).users).toEqual([]);
    expect(present(sent[0]).content).toContain(`<@${person}>`);
    expect(logLines.join("\n")).toContain(taskId);
    expect(await logRows(taskId)).toMatchObject([
      { state: "sent", attempts: 3 },
    ]);
  });

  it("still pings on the second attempt", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const person = fakeId();
    const taskId = await task(guild, eventId, dateOffset(3), "Book", person);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'three_days', $2)`,
      [taskId, dateOffset(3)],
    );
    await database.query(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );
    await run({ guilds: [guild] });
    expect(present(sent[0]).users).toEqual([person]);
  });
});

describe("stale claims on tasks the plan left out", () => {
  const staleClaimOn = async (taskId: string, dueDate: string) => {
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'three_days', $2)`,
      [taskId, dueDate],
    );
    await database.exec(
      `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
    );
  };

  it("closes the claim on a missing thread, with no takeover and no rise in attempts", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaimOn(taskId, dateOffset(3));
    await database.query(
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
      [eventId],
    );
    let reclaims = 0;
    sqlGate = (call) => {
      reclaims += names(call, "reclaim_reminder") ? 1 : 0;
      return undefined;
    };

    for (let day = 0; day < 3; day += 1) {
      await nextDay();
      await run({ guilds: [guild] });
    }

    expect(reclaims).toBe(0);
    expect(await logRows(taskId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
    expect(posts()).toEqual([]);
  });

  it("does the same for a guild no longer allowed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaimOn(taskId, dateOffset(3));
    await run({ guilds: [] });
    expect(await logRows(taskId)).toMatchObject([
      { state: "claimed", attempts: 1 },
    ]);
  });

  it.each([
    [
      "its event is closed",
      `UPDATE public.events SET status = 'closed' WHERE id = $1`,
    ],
    [
      "its event is deleted",
      `UPDATE public.events SET deleted_at = now() WHERE id = $1`,
    ],
    [
      "its forum is no longer managed",
      `UPDATE public.managed_channels SET status = 'removed'
       WHERE (guild_id, channel_id) = (SELECT guild_id, channel_id FROM public.events WHERE id = $1)`,
    ],
  ])("closes the claim as skipped when %s", async (_label, change) => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaimOn(taskId, dateOffset(3));
    await database.query(change, [eventId]);

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(await logRows(taskId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
    expect(posts()).toEqual([]);
  });

  it("counts a cut-short read of stale claims as incomplete, so the recovery run goes on", async () => {
    const guild = await guildInZone();
    // Rows come back as the values of the selected columns, in order, and these fail
    // their checks, so only their number matters.
    const page = Array.from({ length: 501 }, () => [
      "not-a-uuid",
      ...Array.from({ length: 6 }, () => null),
    ]);
    sqlGate = (call) =>
      names(call, "reminder_log") && call.sql.includes("claimed_at <")
        ? { rows: page }
        : undefined;

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({
      status: "failed",
      error: "reminders_incomplete",
    });
    expect((await jobRow()).results).toMatchObject({ stale_truncated: 1 });
  });

  it("closes the claim once the task is finished", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaimOn(taskId, dateOffset(3));
    await database.query(
      `UPDATE public.tasks SET status = 'done', completed_at = now() WHERE id = $1`,
      [taskId],
    );
    await run({ guilds: [guild] });
    expect(await logRows(taskId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
  });
});

describe("the worst case for time", () => {
  /** More than fit in one message, so the first batch is the largest there can be. */
  const BATCH = 60;
  const FUNCTION_LIMIT_MS = 60_000;

  // Every call takes its whole limit. Statements share theirs across the calls
  // that run at once, and the managed check is inside the Discord operation's budget.
  it.each([20_000, 30_000, 35_000, 39_000, 39_900])(
    "records the run in time when the largest batch starts at %i ms",
    async (startsAt) => {
      const guild = await guildInZone();
      const { eventId } = await eventWithThread(guild);
      for (let index = 0; index < BATCH; index += 1) {
        await task(guild, eventId, dateOffset(3), "t");
      }
      const start = Date.now();
      let elapsed = 0;
      let finishedAt = 0;
      sqlGate = (call) => {
        if (names(call, "reminder_log")) {
          elapsed = Math.max(elapsed, startsAt);
        }
        elapsed += DATABASE_CALL_MS / 8;
        if (names(call, "finish_job_run")) {
          elapsed += DATABASE_CALL_MS;
          finishedAt = elapsed;
        }
        return undefined;
      };
      discordGate = () => {
        elapsed += DISCORD_OPERATION_MS / 2;
        return undefined;
      };

      await run({ guilds: [guild], now: () => new Date(start + elapsed) });

      expect(finishedAt).toBeGreaterThan(startsAt);
      expect(finishedAt).toBeLessThanOrEqual(FUNCTION_LIMIT_MS);
    },
  );

  it("leaves marks not started by the hard stop, and says so", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    for (let index = 0; index < BATCH; index += 1) {
      await task(guild, eventId, dateOffset(3), "t");
    }
    const start = Date.now();
    let elapsed = 0;
    discordGate = (method) => {
      if (method === "POST") {
        elapsed = RUN_HARD_STOP_MS;
      }
      return undefined;
    };

    const result = await run({
      guilds: [guild],
      now: () => new Date(start + elapsed),
    });

    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ error: "reminders_incomplete" });
    const { results } = await jobRow();
    expect(results.claimed).toBe(5);
    expect(results.mark_failed).toBe(results.claimed);
    expect(results.reminders_sent).toBeUndefined();
  });

  it("claims nothing once the deadline has passed mid-batch", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const ids: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      ids.push(await task(guild, eventId, dateOffset(3), "t"));
    }
    const start = Date.now();
    let elapsed = 0;
    sqlGate = (call) => {
      if (names(call, "claim_reminder")) {
        elapsed = 60_000;
      }
      return undefined;
    };

    await run({ guilds: [guild], now: () => new Date(start + elapsed) });

    const rows = (await Promise.all(ids.map(logRows))).flat();
    // Only the calls already started when the time ran out.
    expect(rows.length).toBeLessThanOrEqual(8);
    expect((await jobRow()).results.deferred_deadline).toBe(20 - rows.length);
  });
});

describe("planning per guild", () => {
  it("catches an invalid time zone for that guild alone", async () => {
    const broken = await guildInZone();
    const working = await guildInZone();
    const brokenEvent = await eventWithThread(broken);
    const workingEvent = await eventWithThread(working);
    const brokenTask = await task(broken, brokenEvent.eventId, dateOffset(3));
    await task(working, workingEvent.eventId, dateOffset(3));
    await database.exec(
      `ALTER TABLE public.guild_config DISABLE TRIGGER guild_config_check_timezone`,
    );
    await database.query(
      `UPDATE public.guild_config SET timezone = 'Not/AZone' WHERE guild_id = $1`,
      [broken.guildId],
    );
    await database.exec(
      `ALTER TABLE public.guild_config ENABLE TRIGGER guild_config_check_timezone`,
    );

    const result = await run({ guilds: [broken, working] });

    expect(result).toMatchObject({
      status: "failed",
      error: "guild_plan_failed",
    });
    expect(sent.map((message) => message.threadId)).toEqual([
      workingEvent.threadId,
    ]);
    expect(await logRows(brokenTask)).toEqual([]);
    expect((await jobRow()).results).toMatchObject({ guilds_invalid_zone: 1 });
    expect(logLines.join("\n")).toContain(broken.guildId);
  });

  it("sends only the most urgent after a missed run, and skips the rest", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(-2));

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).content).toContain("2 days ago");
    const rows = await logRows(taskId);
    expect(
      Object.fromEntries(rows.map((row) => [row.kind, row.state])),
    ).toEqual({
      three_days: "skipped",
      one_day: "skipped",
      due_day: "skipped",
      overdue: "sent",
    });
    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(1);
  });

  it("closes a stale claim on an older kind by skipping it", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, todayUtc());
    await queryAs(
      database,
      "bot_app",
      `SELECT public.claim_reminder($1, 'one_day', $2)`,
      [taskId, todayUtc()],
    );
    await database.query(
      `UPDATE public.reminder_log SET claimed_at = $1 WHERE task_id = $2`,
      [new Date(Date.now() - STALE_CLAIM_MS * 2), taskId],
    );

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    const rows = await logRows(taskId);
    expect(
      Object.fromEntries(rows.map((row) => [row.kind, row.state])),
    ).toEqual({ three_days: "skipped", one_day: "skipped", due_day: "sent" });
  });
});

describe("days around a change of clocks", () => {
  const NEW_YORK = "America/New_York";

  it.each([
    // Spring forward: 2026-03-08. Both crons of the slot plan for the 8th.
    ["2026-03-08T15:00:00Z", "2026-03-08", "due today"],
    ["2026-03-08T17:00:00Z", "2026-03-08", "due today"],
    ["2026-03-08T15:00:00Z", "2026-03-09", "1 day left"],
    ["2026-03-08T17:00:00Z", "2026-03-11", "3 days left"],
    // A run by hand before 15:00 UTC belongs to the slot that began the day before.
    ["2026-03-08T04:30:00Z", "2026-03-08", "1 day left"],
    ["2026-03-08T14:00:00Z", "2026-03-08", "1 day left"],
    // Fall back: 2026-11-01, including the repeated hour.
    ["2026-11-01T15:00:00Z", "2026-11-01", "due today"],
    ["2026-11-01T17:00:00Z", "2026-11-01", "due today"],
    ["2026-11-01T15:00:00Z", "2026-11-02", "1 day left"],
    ["2026-11-01T17:00:00Z", "2026-10-31", "1 day ago"],
    ["2026-11-01T05:30:00Z", "2026-11-01", "1 day left"],
    ["2026-11-01T06:30:00Z", "2026-11-01", "1 day left"],
    ["2026-11-02T15:00:00Z", "2026-11-02", "due today"],
    ["2026-11-02T17:00:00Z", "2026-11-02", "due today"],
  ])("at %s a task due %s reads %s", async (instant, dueDate, expected) => {
    const guild = await guildInZone(NEW_YORK);
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dueDate);

    await run({ guilds: [guild], now: new Date(instant) });

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).content).toContain(expected);
  });

  // Midnight in Singapore falls between the two crons: 23:00 and then 01:00 there.
  it.each(["2026-11-04T15:00:00Z", "2026-11-04T17:00:00Z"])(
    "plans the same Singapore day at %s",
    async (instant) => {
      const guild = await guildInZone("Asia/Singapore");
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, "2026-11-05");

      await run({ guilds: [guild], now: new Date(instant) });

      expect(sent).toHaveLength(1);
      expect(present(sent[0]).content).toContain("1 day left");
    },
  );

  it("uses each guild's own date", async () => {
    const auckland = await guildInZone("Pacific/Auckland");
    const newYork = await guildInZone(NEW_YORK);
    const dueDate = "2026-11-05";
    const aucklandEvent = await eventWithThread(auckland);
    const newYorkEvent = await eventWithThread(newYork);
    await task(auckland, aucklandEvent.eventId, dueDate);
    await task(newYork, newYorkEvent.eventId, dueDate);

    await run({
      guilds: [auckland, newYork],
      now: new Date("2026-11-04T15:00:00Z"),
    });

    const byThread = new Map(
      sent.map((message) => [message.threadId, message.content]),
    );
    expect(byThread.get(aucklandEvent.threadId)).toContain("due today");
    expect(byThread.get(newYorkEvent.threadId)).toContain("1 day left");
  });
});

describe("what a failure leaves behind", () => {
  it("records a database failure as its category and code", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    sqlGate = (call) =>
      names(call, "tasks") ? serverError("23514") : undefined;
    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({
      status: "failed",
      error: "constraint:23514",
    });
    const row = await jobRow();
    expect(row.error).toBe("constraint:23514");
    expect(requests).toEqual([]);
  });

  it("does not send a reminder that could not be claimed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    await task(guild, eventId, dateOffset(3));
    sqlGate = (call) =>
      names(call, "claim_reminder") ? serverError("XX000") : undefined;

    await run({ guilds: [guild] });

    expect(posts()).toEqual([]);
    expect((await jobRow()).results).toMatchObject({ claim_failed: 1 });
  });

  it("stops claiming when the database keeps refusing claims", async () => {
    const guild = await guildInZone();
    for (let index = 0; index < 5; index += 1) {
      const { eventId } = await eventWithThread(guild);
      await task(guild, eventId, dateOffset(3));
    }
    sqlGate = (call) =>
      names(call, "claim_reminder") ? serverError("XX000") : undefined;

    await run({ guilds: [guild] });

    expect((await jobRow()).results).toMatchObject({
      claim_failed: 3,
      deferred_retrying: 2,
    });
  });

  it("counts a send whose mark failed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    sqlGate = (call) =>
      names(call, "mark_reminder_sent") ? serverError("XX000") : undefined;

    const result = await run({ guilds: [guild] });

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    expect((await jobRow()).results).toMatchObject({ mark_failed: 1 });
  });

  it("reports a failed lock without touching Discord", async () => {
    const guild = await guildInZone();
    sqlGate = (call) =>
      names(call, "begin_job_run") ? serverError("XX000") : undefined;
    const result = await run({ guilds: [guild] });
    expect(result).toEqual({
      status: "failed",
      id: null,
      results: {},
      error: "unavailable:XX000",
    });
    expect(requests).toEqual([]);
  });
});
