/**
 * The reminder run against the real schema, with Discord mocked at `fetch`. The
 * database's own functions decide every claim, so these exercise the same paths as
 * production apart from the network.
 */

import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  pgliteSql,
  serverError,
  type Intercept,
} from "../support/sql-client.ts";
import { stubGlobal } from "../support/stubs.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { getLatestSucceededJobRun } from "../../src/db/job-runs.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import {
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
  stubGlobal("fetch", async (input: string, init?: RequestInit) => {
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
function dateOffset(days: number): string {
  return new Date(slotStart(new Date()) + days * 86_400_000)
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

/** A guild with one event per entry, each holding one task due in that many days. */
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
}

async function logRows(taskId: string): Promise<LogRow[]> {
  const { rows } = await database.query<LogRow>(
    `SELECT task_id, kind, state, attempts, message_id
     FROM public.reminder_log WHERE task_id = $1 ORDER BY kind`,
    [taskId],
  );
  return rows;
}

async function allLogRows(taskIds: string[]): Promise<LogRow[]> {
  return (await Promise.all(taskIds.map(logRows))).flat();
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

/** Claims a reminder as an earlier run would have, and lets the claim go stale. */
async function staleClaim(
  taskId: string,
  kind: string,
  dueDate: string,
  attempts = 1,
): Promise<void> {
  await queryAs(
    database,
    "bot_app",
    `SELECT public.claim_reminder($1, $2, $3)`,
    [taskId, kind, dueDate],
  );
  await database.query(
    `UPDATE public.reminder_log SET attempts = $2, claimed_at = now() - interval '2 hours'
     WHERE task_id = $1`,
    [taskId, attempts],
  );
}

/** The 17:00 cron, by which time a morning claim has gone stale. */
async function staleAllClaims(): Promise<void> {
  await database.exec(
    `UPDATE public.reminder_log SET claimed_at = now() - interval '2 hours'`,
  );
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

async function latestSucceeded() {
  return getLatestSucceededJobRun(db, { jobName: "reminders" });
}

const refuseText = () => Response.json({ code: 200000 }, { status: 400 });
const unavailable503 = () => new Response("unavailable", { status: 503 });

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
  mockDiscord();
  await database.exec(`
    UPDATE public.tasks SET deleted_at = now() WHERE deleted_at IS NULL;
    DELETE FROM public.reminder_log;
    DELETE FROM public.event_reminder_log;
    DELETE FROM public.job_runs;
  `);
});

describe("a normal run", () => {
  it("claims, sends once to the thread and marks sent", async () => {
    const guild = await guildInZone();
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
    expect(await logRows(notYetDue)).toEqual([]);
    expect((await jobRow()).results).toMatchObject({
      messages_sent: 1,
      reminders_sent: 1,
    });
  });

  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    await run({ guilds: [] });
    expect(requests).toEqual([]);
    expect(await logRows(present(event).taskId)).toEqual([]);
    expect((await jobRow()).results).toMatchObject({ guilds_not_allowed: 1 });
  });
});

describe("a repeated run", () => {
  it("sends once when invoked twice in a row", async () => {
    const guild = await guildInZone();
    await eventsDueIn(guild, [3]);

    expect((await run({ guilds: [guild] })).status).toBe("succeeded");
    requests = [];
    // The same slot's recovery cron, or a second delivery of the first.
    expect((await run({ guilds: [guild] })).status).toBe("duplicate");

    expect(requests).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});

describe("a crash between send and mark", () => {
  it("leaves the claim, then resends exactly once the next day", async () => {
    const guild = await guildInZone();
    const [event] = await eventsDueIn(guild, [3]);
    const taskId = present(event).taskId;
    // After the first send, every database request fails, as if the process died.
    let crashed = false;
    discordGate = (method) => {
      crashed ||= method === "POST";
      return undefined;
    };
    sqlGate = () => (crashed ? serverError("XX000") : undefined);

    await run({ guilds: [guild] });
    expect(sent).toHaveLength(1);
    expect(await logRows(taskId)).toMatchObject([{ state: "claimed" }]);
    crashed = false;
    discordGate = () => undefined;
    sqlGate = () => undefined;

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
});

describe("reminders turned off during a run", () => {
  it("sends nothing further once the switch is off", async () => {
    const guild = await guildInZone();
    const events = await eventsDueIn(guild, [3, 3, 3]);
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
    const rows = await allLogRows(events.map((event) => event.taskId));
    expect(rows.map((row) => row.state)).toEqual(["sent"]);
    expect((await jobRow()).results).toMatchObject({ claim_lost: 2 });
  });
});

describe("volume and long text", () => {
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

  it("leaves what is over the cap unclaimed and records it", async () => {
    const guild = await guildInZone();
    const events = await eventsDueIn(guild, [3, 3, 3]);

    const result = await run({ guilds: [guild], limits: { maxMessages: 2 } });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(2);
    expect((await jobRow()).results).toMatchObject({
      messages_sent: 2,
      deferred_cap: 1,
    });
    expect(logLines.join("\n")).toContain("message cap");
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      2,
    );

    // A same-day repeat must not send the remainder.
    expect((await run({ guilds: [guild] })).status).toBe("duplicate");
    expect(sent).toHaveLength(2);

    await nextDay();
    await run({ guilds: [guild] });
    expect(sent).toHaveLength(3);
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
    // The long task's button goes only on the message where its text ends.
    const parts = sent.filter((message) => message.content.includes("\\_"));
    expect(
      parts.map((message) => message.buttons.includes(`task.done:${long}`)),
    ).toEqual(parts.map((_, index) => index === parts.length - 1));
    expect(sent.flatMap((message) => message.buttons).sort()).toEqual(
      [`task.done:${long}`, `task.done:${short}`].sort(),
    );
    expect(await allLogRows([long, short])).toMatchObject([
      { state: "sent" },
      { state: "sent" },
    ]);
  });
});

describe("text that Discord refuses", () => {
  const POISON = "forbiddenword";

  it("does not block the others in its message or event", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const good = await task(guild, eventId, dateOffset(3), "Good one");
    const bad = await task(guild, eventId, dateOffset(3), POISON);
    const other = await task(guild, eventId, dateOffset(3), "Good two");
    discordGate = (method, _path, message) =>
      method === "POST" && message?.content.includes(POISON)
        ? refuseText()
        : undefined;

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(sent.map((message) => message.content).join()).not.toContain(POISON);
    expect(await allLogRows([good, other, bad])).toMatchObject([
      { state: "sent" },
      { state: "sent" },
      { state: "skipped" },
    ]);
    expect((await jobRow()).results).toMatchObject({
      items_refused: 1,
      batches_retried: 1,
      reminders_sent: 2,
    });
    expect(logLines.join("\n")).toContain(bad);
    expect(logLines.join("\n")).not.toContain(POISON);
  });

  it("sends a task with no visible text, with a stand-in", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const invisible = await task(guild, eventId, dateOffset(3), "​​");
    await task(guild, eventId, dateOffset(3), "Good");

    await run({ guilds: [guild] });

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).content).toContain("no readable description");
    expect(await logRows(invisible)).toMatchObject([{ state: "sent" }]);
    expect((await jobRow()).results).toMatchObject({ render_stand_in: 1 });
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
    const guild = await guildInZone();
    const events = await eventsDueIn(guild, [3, 3]);
    discordGate = answer;

    const result = await run({ guilds: [guild] });

    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({ status: "failed", error });
    const row = await jobRow();
    expect(row).toMatchObject({ status: "failed", error });
    expect(row.results).toMatchObject({ deferred_halted: 1 });
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      1,
    );
  });

  it("stops at a failure that may clear, and the 17:00 run sends what it left", async () => {
    const guild = await guildInZone();
    const events = await eventsDueIn(guild, [3, 3, 3]);
    const taskIds = events.map((event) => event.taskId);
    discordGate = (method) =>
      method === "POST" ? unavailable503() : undefined;

    const morning = await run({ guilds: [guild] });

    expect(posts()).toHaveLength(1);
    expect(morning).toMatchObject({
      status: "failed",
      error: "discord_api:503",
    });
    expect((await jobRow()).results).toMatchObject({
      retry_later: 1,
      deferred_halted: 2,
    });
    expect(await allLogRows(taskIds)).toHaveLength(1);
    // What the health check's freshness alert reads.
    expect(await latestSucceeded()).toEqual({ ok: true, value: null });

    discordGate = () => undefined;
    await staleAllClaims();
    expect((await run({ guilds: [guild] })).status).toBe("succeeded");

    expect(sent).toHaveLength(3);
    expect(await allLogRows(taskIds)).toMatchObject([
      { state: "sent" },
      { state: "sent" },
      { state: "sent" },
    ]);
    expect(await latestSucceeded()).toMatchObject({
      ok: true,
      value: { job_name: "reminders", status: "succeeded" },
    });
  });
});

describe("targets that are gone or not ours", () => {
  it("marks the forum, and skips its other events, only when a GET says it is gone", async () => {
    const guild = await guildInZone();
    const events = await eventsDueIn(guild, [3, 3]);
    discordGate = () => Response.json({ code: 10003 }, { status: 404 });

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    const { rows } = await database.query<{ status: string }>(
      `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
      [guild.guildId],
    );
    expect(rows).toEqual([{ status: "unavailable" }]);
    expect(requests).toHaveLength(2);
    expect(await allLogRows(events.map((event) => event.taskId))).toHaveLength(
      1,
    );
    expect((await jobRow()).results).toMatchObject({
      channels_gone: 1,
      claim_lost: 1,
    });
  });

  it("sends nothing to a thread whose parent is not managed, and keeps the claim", async () => {
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
  it.each<[string, number, string]>([
    ["a proxy's HTML 403", 403, "<html>blocked</html>"],
    ["a locked thread", 403, JSON.stringify({ code: 160005 })],
    ["a 404 with no code", 404, "nf"],
  ])(
    "keeps the reminder after %s, and goes on",
    async (_label, status, body) => {
      const guild = await guildInZone();
      const [first, second] = await eventsDueIn(guild, [3, 3]);
      const failing = present(first);
      const other = present(second);
      const taskId = failing.taskId;
      discordGate = (method, path) =>
        method === "POST" && path.startsWith(`/channels/${failing.threadId}`)
          ? new Response(body, {
              status,
              headers: { "content-type": "application/json" },
            })
          : undefined;

      const result = await run({ guilds: [guild] });

      expect(result).toMatchObject({ error: "reminders_incomplete" });
      expect(sent.map((message) => message.threadId)).toEqual([other.threadId]);
      expect(await logRows(taskId)).toMatchObject([
        { state: "claimed", attempts: 1 },
      ]);

      discordGate = () => undefined;
      await nextDay();
      await run({ guilds: [guild] });
      expect(sent).toHaveLength(2);
      expect(await logRows(taskId)).toMatchObject([
        { state: "sent", attempts: 2 },
      ]);
    },
  );
});

describe("a failed morning and the recovery cron", () => {
  it.each<[string, number, string]>([
    ["due today", 0, "due_day"],
    ["due tomorrow", 1, "one_day"],
  ])(
    "leaves the slot open for the recovery cron after a rerun, for a task %s",
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
        method === "POST" ? unavailable503() : undefined;
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

      await staleAllClaims();
      const recovery = await run({ guilds: [guild] });

      expect(recovery.status).toBe("succeeded");
      expect(sent.map((message) => message.threadId)).toEqual([threadId]);
      expect(present(sent[0]).users).toEqual([person]);
      expect(await logRows(taskId)).toContainEqual(
        expect.objectContaining({ kind, state: "sent" }) as LogRow,
      );
    },
  );
});

describe("the repeat-ping guard", () => {
  it.each<[number, boolean]>([
    [1, true],
    [2, false],
  ])(
    "after %i earlier attempts, pings the assignee: %p",
    async (attempts, pings) => {
      const guild = await guildInZone();
      const { eventId } = await eventWithThread(guild);
      const person = fakeId();
      const taskId = await task(guild, eventId, dateOffset(3), "Book", person);
      await staleClaim(taskId, "three_days", dateOffset(3), attempts);

      await run({ guilds: [guild] });

      expect(sent).toHaveLength(1);
      expect(present(sent[0]).users).toEqual(pings ? [person] : []);
      expect(present(sent[0]).content).toContain(`<@${person}>`);
      expect(await logRows(taskId)).toMatchObject([
        { state: "sent", attempts: attempts + 1 },
      ]);
      if (!pings) {
        expect(logLines.join("\n")).toContain(taskId);
      }
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
    ["a server error", () => new Response("bad", { status: 503 }), false, 0],
  ])(
    "after two runs ending in %s, pings on the third: %p",
    async (_label, answer, pings, refused) => {
      const guild = await guildInZone();
      const person = fakeId();
      const { eventId } = await eventWithThread(guild);
      const taskId = await task(guild, eventId, dateOffset(-5), "Book", person);

      discordGate = (method) => (method === "POST" ? answer() : undefined);
      await run({ guilds: [guild] });
      await nextDay();
      await run({ guilds: [guild] });
      await nextDay();
      discordGate = () => undefined;
      await run({ guilds: [guild] });

      expect(sent).toHaveLength(1);
      expect(present(sent[0]).users).toEqual(pings ? [person] : []);
      expect(await refusedAttempts(taskId, "overdue")).toBe(refused);
    },
  );
});

describe("a task changed after the run read it", () => {
  it("does not ping the old assignee, and the recovery cron pings the new one", async () => {
    const guild = await guildInZone();
    const first = await eventWithThread(guild);
    const second = await eventWithThread(guild);
    await task(guild, first.eventId, dateOffset(1), "Sent first");
    const taskId = await task(
      guild,
      second.eventId,
      dateOffset(3),
      "Old text",
      fakeId(),
    );
    const after = fakeId();
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
});

describe("stale claims on tasks the plan left out", () => {
  it("leaves the claim alone for a guild no longer allowed", async () => {
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaim(taskId, "three_days", dateOffset(3));
    await run({ guilds: [] });
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
    const guild = await guildInZone();
    const { eventId } = await eventWithThread(guild);
    const taskId = await task(guild, eventId, dateOffset(3));
    await staleClaim(taskId, "three_days", dateOffset(3));
    await database.query(change, [eventId]);

    const result = await run({ guilds: [guild] });

    expect(result.status).toBe("succeeded");
    expect(await logRows(taskId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
    expect(posts()).toEqual([]);
  });
});

describe("planning per guild", () => {
  it("sends only the most urgent after a missed run, and skips the rest", async () => {
    const guild = await guildInZone();
    const [event] = await eventsDueIn(guild, [-2]);
    const taskId = present(event).taskId;

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
  });
});

describe("days around a change of clocks", () => {
  const NEW_YORK = "America/New_York";

  it.each([
    // Spring forward: 2026-03-08. Both crons of the slot plan for the 8th.
    ["2026-03-08T15:00:00Z", "2026-03-08", "due today"],
    ["2026-03-08T17:00:00Z", "2026-03-11", "3 days left"],
    // A run by hand before 15:00 UTC belongs to the slot that began the day before.
    ["2026-03-08T04:30:00Z", "2026-03-08", "1 day left"],
    // Fall back: 2026-11-01, including the repeated hour.
    ["2026-11-01T17:00:00Z", "2026-11-01", "due today"],
    ["2026-11-01T17:00:00Z", "2026-10-31", "1 day ago"],
    ["2026-11-01T05:30:00Z", "2026-11-01", "1 day left"],
    ["2026-11-01T06:30:00Z", "2026-11-01", "1 day left"],
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
