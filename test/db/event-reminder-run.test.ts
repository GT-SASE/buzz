/**
 * The event workflow reminders, run as part of the daily reminder run against the real
 * schema, with Discord mocked at `fetch`. The database's own functions decide every
 * claim, including which days a pickup reminder may be claimed for.
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
import { names, pgliteSql, type Intercept } from "../support/sql-client.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import {
  assignEventStep,
  completeEventStep,
  setEventPickupTime,
} from "../../src/db/event-steps.ts";
import type {
  AssignableStepKind,
  CompletableStepKind,
} from "../../src/db/types.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import {
  runReminders,
  type RunLimits,
  type RunResult,
} from "../../src/reminders/run.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { messageBody } from "../support/json.ts";
import {
  finishEventSteps,
  insertGuild,
  type WorkflowGuildFixture,
} from "./fixtures.ts";
import { createMigratedDb, fakeId, present, queryAs } from "./harness.ts";

const API = "https://discord.com/api/v10";
const TOKEN = "unit-test-token";

interface Sent {
  threadId: string;
  content: string;
  users: string[];
  roles: string[];
  parse: string[];
}

type DiscordAnswer = Response | undefined;

let database: PGlite;
let db: DbClient;
let discordGate: (
  method: string,
  path: string,
) => DiscordAnswer | Promise<DiscordAnswer>;
let requests: { method: string; path: string }[];
let sent: Sent[];
let threadParents: Map<string, { guildId: string; parentId: string }>;
let logLines: string[];
let sqlGate: Intercept = () => undefined;

function posts() {
  return requests.filter((request) => request.method === "POST");
}

function mockDiscord(): void {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (!url.startsWith(API)) {
      throw new Error(`Unexpected request to ${url}`);
    }
    const path = url.slice(API.length);
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    const channelId = /^\/channels\/([0-9]+)/.exec(path)?.[1] ?? "";
    const answer = await discordGate(method, path);
    if (answer !== undefined) {
      return answer;
    }
    if (method === "POST") {
      const body = messageBody(init?.body);
      sent.push({
        threadId: channelId,
        content: body.content,
        users: body.users,
        roles: body.roles,
        parse: body.parse,
      });
      return Response.json({ id: fakeId() });
    }
    const thread = threadParents.get(channelId);
    return thread === undefined
      ? Response.json({ id: channelId, type: 15, guild_id: "0" })
      : Response.json({
          id: channelId,
          type: 11,
          guild_id: thread.guildId,
          parent_id: thread.parentId,
        });
  });
}

function run(
  guilds: readonly WorkflowGuildFixture[],
  limits?: Partial<RunLimits>,
  now?: Date,
): Promise<RunResult> {
  return runReminders({
    db,
    client: createDiscordClient({
      check: managedChannelCheck(db),
      env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: fakeId() },
      sleep: () => Promise.resolve(),
    }),
    allowedGuildIds: new Set(guilds.map((guild) => guild.guildId)),
    log: (line) => logLines.push(line),
    ...(limits === undefined ? {} : { limits }),
    ...(now === undefined ? {} : { now: () => now }),
  });
}

/** Days from the date a run plans for in a UTC guild: that of its slot's start. */
function dateOffset(days: number): string {
  return new Date(slotStart(new Date()) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A guild whose zone is UTC, so test dates and "today" agree. */
async function guildInUtc(): Promise<WorkflowGuildFixture> {
  const guild = await insertGuild(database);
  await database.query(
    `UPDATE public.guild_config SET timezone = 'UTC' WHERE guild_id = $1`,
    [guild.guildId],
  );
  return guild;
}

interface EventFixture {
  eventId: string;
  threadId: string;
  creatorId: string;
}

async function event(
  guild: WorkflowGuildFixture,
  days: number,
  name = "Spring social",
): Promise<EventFixture> {
  const threadId = fakeId();
  const creatorId = fakeId();
  threadParents.set(threadId, {
    guildId: guild.guildId,
    parentId: guild.channelId,
  });
  const rows = await queryAs<{ id: string }>(
    database,
    "bot_app",
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active')
     RETURNING id`,
    [
      guild.guildId,
      guild.channelId,
      name,
      dateOffset(days),
      creatorId,
      threadId,
    ],
  );
  return { eventId: present(rows[0]).id, threadId, creatorId };
}

async function assign(
  guild: WorkflowGuildFixture,
  made: EventFixture,
  kind: AssignableStepKind,
  userId = fakeId(),
): Promise<string> {
  const result = await assignEventStep(db, {
    guildId: guild.guildId,
    eventId: made.eventId,
    kind,
    userId,
    actorId: fakeId(),
  });
  expect(result).toEqual({ ok: true, value: true });
  return userId;
}

async function complete(
  guild: WorkflowGuildFixture,
  made: EventFixture,
  kind: CompletableStepKind,
): Promise<void> {
  const result = await completeEventStep(db, {
    guildId: guild.guildId,
    eventId: made.eventId,
    kind,
    actorId: fakeId(),
  });
  expect(result).toEqual({ ok: true, value: true });
}

/** Budget Sheet, Engage post and Budget approved done, and Food pickup set up. */
async function readyForPickup(
  guild: WorkflowGuildFixture,
  made: EventFixture,
  people = [fakeId()],
): Promise<string[]> {
  await complete(guild, made, "budget_sheet");
  await complete(guild, made, "engage_post");
  await complete(guild, made, "budget_approved");
  for (const person of people) {
    await assign(guild, made, "food_pickup", person);
  }
  const set = await setEventPickupTime(db, {
    guildId: guild.guildId,
    eventId: made.eventId,
    pickupTime: "17:30",
    actorId: fakeId(),
  });
  expect(set).toEqual({ ok: true, value: true });
  return people;
}

interface LogRow {
  kind: string;
  reminder_date: string;
  state: string;
  attempts: number;
}

async function logRows(eventId: string): Promise<LogRow[]> {
  const { rows } = await database.query<LogRow>(
    `SELECT kind, to_char(reminder_date, 'YYYY-MM-DD') AS reminder_date, state, attempts
     FROM public.event_reminder_log WHERE event_id = $1 ORDER BY kind, reminder_date`,
    [eventId],
  );
  return rows;
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

async function claimAgo(
  eventId: string,
  kind: string,
  reminderDate: string,
  minutes: number,
): Promise<void> {
  await database.query(
    `INSERT INTO public.event_reminder_log (event_id, kind, reminder_date, claimed_at)
     VALUES ($1, $2, $3, now() - make_interval(mins => $4))`,
    [eventId, kind, reminderDate, minutes],
  );
}

beforeAll(async () => {
  database = await createMigratedDb();
  db = createDbClient(pgliteSql(database, (call) => sqlGate(call)));
});

afterAll(() => database.close());

beforeEach(async () => {
  discordGate = () => undefined;
  requests = [];
  sent = [];
  threadParents = new Map();
  logLines = [];
  sqlGate = () => undefined;
  mockDiscord();
  // Events from earlier tests stay, but in guilds no later test allows.
  await database.exec(`
    DELETE FROM public.event_reminder_log;
    DELETE FROM public.job_runs;
  `);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the daily step list", () => {
  it("pings each open step's people, lists approval without a ping, and marks sent", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 5);
    const budget = [
      await assign(guild, made, "budget_sheet"),
      await assign(guild, made, "budget_sheet"),
    ];
    const engage = await assign(guild, made, "engage_post");

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    const message = present(sent[0]);
    expect(message.threadId).toBe(made.threadId);
    expect(message.parse).toEqual([]);
    expect(message.roles).toEqual([]);
    expect(message.users.sort()).toEqual([...budget, engage].sort());
    expect(message.content).toContain("Spring social");
    expect(message.content).toContain(
      `Budget Sheet: ${budget.map((user) => `<@${user}>`).join(" ")}`,
    );
    expect(message.content).toContain(`Engage post: <@${engage}>`);
    expect(message.content).toContain("Budget approved: waiting for approval");
    expect(message.content).not.toContain("Food pickup");
    expect(message.content).toContain("in 5 days");
    expect(await logRows(made.eventId)).toEqual([
      {
        kind: "daily_steps",
        reminder_date: dateOffset(0),
        state: "sent",
        attempts: 1,
      },
    ]);
    expect((await jobRow()).results).toMatchObject({
      event_planned: 1,
      event_claimed: 1,
      event_reminders_sent: 1,
      event_daily_steps_sent: 1,
      messages_sent: 1,
    });
  });

  it("pings the Events Directors role for a step nobody is on", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    const budget = await assign(guild, made, "budget_sheet");

    await run([guild]);

    const message = present(sent[0]);
    expect(message.users).toEqual([budget]);
    expect(message.roles).toEqual([guild.officerRoleId]);
    expect(message.content).toContain(
      `Engage post: nobody is on it yet, <@&${guild.officerRoleId}>`,
    );
  });

  it("leaves out finished steps", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    await assign(guild, made, "budget_sheet");
    await complete(guild, made, "budget_sheet");
    const engage = await assign(guild, made, "engage_post");

    await run([guild]);

    const message = present(sent[0]);
    expect(message.content).not.toContain("Budget Sheet");
    expect(message.content).toContain(`Engage post: <@${engage}>`);
    expect(message.users).toEqual([engage]);
    expect(message.roles).toEqual([]);
  });

  it("sends no step list when only Food pickup is open", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    await complete(guild, made, "budget_sheet");
    await complete(guild, made, "engage_post");
    await complete(guild, made, "budget_approved");
    await assign(guild, made, "food_pickup");

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
  });

  it("never mentions Food pickup in the step list", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    await complete(guild, made, "budget_sheet");

    await run([guild]);

    const message = present(sent[0]);
    expect(message.content).not.toMatch(/food pickup/i);
    expect(message.users).not.toContain(made.creatorId);
  });

  it("sends nothing and claims nothing when every step is done", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 5);
    await readyForPickup(guild, made);

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
  });

  it("goes out on the event's day, and not after it", async () => {
    const guild = await guildInUtc();
    const today = await event(guild, 0);
    const past = await event(guild, -1);

    await run([guild]);

    expect(sent.map((message) => message.threadId)).toEqual([today.threadId]);
    expect(present(sent[0]).content).toContain("today");
    expect(await logRows(past.eventId)).toEqual([]);
  });

  it("sends once a day, again the next day", async () => {
    const guild = await guildInUtc();
    await event(guild, 5);

    expect((await run([guild])).status).toBe("succeeded");
    expect((await run([guild])).status).toBe("duplicate");
    expect(sent).toHaveLength(1);
  });
});

describe("Food pickup reminders", () => {
  it("plans the 17:00 UTC recovery run for the same Singapore day as the 15:00 run", async () => {
    // The latest 17:00 UTC that has passed: 01:00 the next day in Singapore, where the
    // slot began at 23:00. The pickup is two days after the slot's date.
    const latest = slotStart(new Date()) + 2 * 3_600_000;
    const recovery = latest <= Date.now() ? latest : latest - 86_400_000;
    const slotDay = new Date(slotStart(new Date(recovery)))
      .toISOString()
      .slice(0, 10);
    const guild = await guildInUtc();
    await database.query(
      `UPDATE public.guild_config SET timezone = 'Asia/Singapore' WHERE guild_id = $1`,
      [guild.guildId],
    );
    const made = await event(guild, 2 - (slotDay === dateOffset(0) ? 0 : 1));
    const people = await readyForPickup(guild, made);

    await run([guild], undefined, new Date(recovery));

    const pickup = sent.find((message) =>
      message.content.includes("you are on food pickup"),
    );
    expect(present(pickup).users).toEqual(people);
    expect(await logRows(made.eventId)).toMatchObject([
      { kind: "pickup_two_days", reminder_date: slotDay, state: "sent" },
    ]);
  });

  it("pings every pickup person two days before, with the time", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 2, "Movie night");
    const people = await readyForPickup(guild, made, [fakeId(), fakeId()]);

    await run([guild]);

    expect(sent).toHaveLength(1);
    const message = present(sent[0]);
    expect(message.threadId).toBe(made.threadId);
    expect(message.users.sort()).toEqual([...people].sort());
    expect(message.roles).toEqual([]);
    expect(message.content).toContain("Movie night");
    expect(message.content).toContain("5\\:30 PM");
    expect(message.content).toContain("in 2 days");
    expect(await logRows(made.eventId)).toEqual([
      {
        kind: "pickup_two_days",
        reminder_date: dateOffset(0),
        state: "sent",
        attempts: 1,
      },
    ]);
  });

  it("pings them again on the day", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 0);
    const people = await readyForPickup(guild, made);

    await run([guild]);

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).users).toEqual(people);
    expect(present(sent[0]).content).toContain("today");
    expect(await logRows(made.eventId)).toMatchObject([
      { kind: "pickup_day", state: "sent" },
    ]);
    expect((await jobRow()).results).toMatchObject({
      event_pickup_day_sent: 1,
    });
  });

  it.each([1, 3, 4])("sends nothing %i days before", async (days) => {
    const guild = await guildInUtc();
    const made = await event(guild, days);
    await readyForPickup(guild, made);

    await run([guild]);

    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
  });

  it("sends nothing until Food pickup has a time and a person, only the step list", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 2);
    await complete(guild, made, "budget_sheet");
    await complete(guild, made, "engage_post");
    await assign(guild, made, "food_pickup");

    await run([guild]);

    expect(sent).toHaveLength(1);
    expect(present(sent[0]).content).toContain("Budget approved");
    expect((await logRows(made.eventId)).map((row) => row.kind)).toEqual([
      "daily_steps",
    ]);
  });

  it("reminds the pickup people before the budget is approved", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 2);
    const person = await assign(guild, made, "food_pickup");
    const set = await setEventPickupTime(db, {
      guildId: guild.guildId,
      eventId: made.eventId,
      pickupTime: "17:30",
      actorId: fakeId(),
    });
    expect(set).toEqual({ ok: true, value: true });

    await run([guild]);

    const pickup = sent.find((message) =>
      message.content.includes("you are on food pickup"),
    );
    expect(present(pickup).users).toEqual([person]);
    expect((await logRows(made.eventId)).map((row) => row.kind)).toEqual([
      "daily_steps",
      "pickup_two_days",
    ]);
  });

  it("is refused by the database on any other day", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    await readyForPickup(guild, made);
    const rows = await queryAs<{ token: string | null }>(
      database,
      "bot_app",
      `SELECT public.claim_event_reminder($1, 'pickup_two_days', $2) AS token`,
      [made.eventId, dateOffset(0)],
    );
    expect(present(rows[0]).token).toBeNull();
  });

  it("sends the step list and the pickup reminder as two messages", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 0);
    await complete(guild, made, "budget_approved");
    const person = await assign(guild, made, "food_pickup");
    await setEventPickupTime(db, {
      guildId: guild.guildId,
      eventId: made.eventId,
      pickupTime: "09:05",
      actorId: fakeId(),
    });

    await run([guild]);

    expect(sent).toHaveLength(2);
    const pickup = sent.find((message) =>
      message.content.includes("9\\:05 AM"),
    );
    expect(pickup?.users).toEqual([person]);
    expect((await logRows(made.eventId)).map((row) => row.kind)).toEqual([
      "daily_steps",
      "pickup_day",
    ]);
  });
});

describe("the recovery cron", () => {
  it("makes no request after a good morning", async () => {
    const guild = await guildInUtc();
    await event(guild, 4);
    await run([guild]);
    requests = [];
    expect((await run([guild])).status).toBe("duplicate");
    expect(requests).toEqual([]);
  });

  it("sends what failed, and does not send again what went out", async () => {
    const guild = await guildInUtc();
    const good = await event(guild, 4);
    const failing = await event(guild, 4);
    discordGate = (method, path) =>
      method === "POST" && path.includes(failing.threadId)
        ? Response.json({ code: 0 }, { status: 404 })
        : undefined;

    const morning = await run([guild]);

    expect(morning).toMatchObject({ error: "reminders_incomplete" });
    expect(sent.map((message) => message.threadId)).toEqual([good.threadId]);
    expect(await logRows(failing.eventId)).toMatchObject([
      { state: "claimed" },
    ]);

    // The claim must be stale before the recovery cron takes it over.
    await database.query(
      `UPDATE public.event_reminder_log SET claimed_at = claimed_at - interval '2 hours'`,
    );
    discordGate = () => undefined;
    sent = [];
    const recovery = await run([guild]);

    expect(recovery.status).toBe("succeeded");
    expect(sent.map((message) => message.threadId)).toEqual([failing.threadId]);
    expect(await logRows(failing.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
    expect(await logRows(good.eventId)).toMatchObject([
      { state: "sent", attempts: 1 },
    ]);
  });
});

describe("claims left by a crashed run", () => {
  it("takes over a stale claim and sends it once", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
    expect((await jobRow()).results).toMatchObject({
      event_stale_found: 1,
      event_stale_reclaimed: 1,
    });
  });

  it("waits on a fresh claim, and does not call the run complete", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 1);

    const result = await run([guild]);

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(posts()).toEqual([]);
    expect((await jobRow()).results).toMatchObject({
      event_fresh_claims_waiting: 1,
    });
  });

  it.each([
    ["is closed", `UPDATE public.events SET status = 'closed' WHERE id = $1`],
    ["is deleted", `UPDATE public.events SET deleted_at = now() WHERE id = $1`],
    [
      "has lost its post",
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
    ],
  ])(
    "closes a stale claim as skipped when the event %s",
    async (_label, change) => {
      const guild = await guildInUtc();
      const made = await event(guild, 4);
      await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
      await database.query(change, [made.eventId]);

      await run([guild]);

      expect(posts()).toEqual([]);
      expect(await logRows(made.eventId)).toMatchObject([
        { state: "skipped", attempts: 1 },
      ]);
      expect((await jobRow()).results).toMatchObject({
        event_skips_recorded: 1,
      });
    },
  );

  /** Turns the guild's reminders on or off, as /config does. */
  async function setReminders(
    guild: WorkflowGuildFixture,
    on: boolean,
  ): Promise<void> {
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_config_change($1,
         (SELECT version FROM public.guild_config WHERE guild_id = $1), $1, $2)`,
      [guild.guildId, on],
    );
  }

  /** Removes the guild's forum from the managed list, or adds it back, as /config does. */
  async function setForum(
    guild: WorkflowGuildFixture,
    managed: boolean,
  ): Promise<void> {
    const [add, remove] = managed
      ? [[guild.channelId], []]
      : [[], [guild.channelId]];
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_config_change($1,
         (SELECT version FROM public.guild_config WHERE guild_id = $1), $1, NULL,
         $2::text[], $3::text[])`,
      [guild.guildId, add, remove],
    );
  }

  /** Lets another run start in this slot, as the recovery cron does after a failed run. */
  async function allowAnotherRun(): Promise<void> {
    await database.query(
      `UPDATE public.job_runs SET status = 'failed', error = 'test' WHERE job_name = 'reminders'`,
    );
  }

  it("keeps today's claim through a pause, and sends it once reminders are back on", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    // A run crashed holding today's claim.
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    await setReminders(guild, false);

    const paused = await run([guild]);

    expect(paused.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toMatchObject([
      { state: "claimed", attempts: 1 },
    ]);
    expect((await jobRow()).results).toMatchObject({ event_stale_left: 1 });

    await setReminders(guild, true);
    await allowAnotherRun();
    const resumed = await run([guild]);

    expect(resumed.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
  });

  it("leaves a paused guild's claims alone, even on a closed event", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    await database.query(
      `UPDATE public.events SET status = 'closed' WHERE id = $1`,
      [made.eventId],
    );
    await setReminders(guild, false);

    await run([guild]);

    expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);
  });

  it("keeps a claim while its forum is unmanaged, and sends it once the forum is back", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    await setForum(guild, false);

    await run([guild]);

    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);

    await setForum(guild, true);
    await allowAnotherRun();
    await run([guild]);

    expect(sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toMatchObject([{ state: "sent" }]);
  });

  it("closes an unplanned claim on an event already past", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, -3);
    await claimAgo(made.eventId, "daily_steps", dateOffset(-3), 3 * 24 * 60);

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(await logRows(made.eventId)).toMatchObject([{ state: "skipped" }]);
  });

  it("closes a stale claim from days ago on a live event", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(-3), 3 * 24 * 60);

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(await logRows(made.eventId)).toEqual([
      expect.objectContaining({
        reminder_date: dateOffset(-3),
        state: "skipped",
      }),
      expect.objectContaining({ reminder_date: dateOffset(0), state: "sent" }),
    ]);
  });

  it("counts a cut-short read of stale claims as incomplete", async () => {
    const guild = await guildInUtc();
    // Rows come back as the values of the selected columns, in order, and these fail
    // their checks, so only their number matters.
    const page = Array.from({ length: 501 }, () => [
      "not-a-uuid",
      ...Array.from({ length: 5 }, () => null),
    ]);
    sqlGate = (call) =>
      names(call, "event_reminder_log") && call.sql.includes("claimed_at <")
        ? { rows: page }
        : undefined;

    const result = await run([guild]);

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect((await jobRow()).results).toMatchObject({
      event_stale_truncated: 1,
    });
  });

  it("counts a stale claim it could not take over as incomplete", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    sqlGate = (call) =>
      names(call, "reclaim_event_reminder")
        ? { rows: [{ value: null }] }
        : undefined;

    const result = await run([guild]);

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(posts()).toEqual([]);
    expect((await jobRow()).results).toMatchObject({
      event_claim_lost: 1,
      event_stale_claim_lost: 1,
    });
  });

  it("closes yesterday's stale claim as skipped, and sends today's", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(-1), 24 * 60);

    await run([guild]);

    expect(sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toEqual([
      expect.objectContaining({
        reminder_date: dateOffset(-1),
        state: "skipped",
      }),
      expect.objectContaining({ reminder_date: dateOffset(0), state: "sent" }),
    ]);
    expect((await jobRow()).results).toMatchObject({
      event_skips_recorded: 1,
    });
  });

  it("closes a stale claim on a list since finished, without sending", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    await finishEventSteps(database, made.eventId);

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toMatchObject([{ state: "skipped" }]);
  });

  it("sends without pings from the third attempt", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    const person = await assign(guild, made, "budget_sheet");
    await claimAgo(made.eventId, "daily_steps", dateOffset(0), 90);
    await database.query(
      `UPDATE public.event_reminder_log SET attempts = 2 WHERE event_id = $1`,
      [made.eventId],
    );

    await run([guild]);

    const message = present(sent[0]);
    expect(message.users).toEqual([]);
    expect(message.roles).toEqual([]);
    expect(message.content).toContain(`<@${person}>`);
  });
});

describe("what stops event reminders", () => {
  it("sends nothing while the guild has reminders off", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 2);
    await readyForPickup(guild, made);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_config_change($1, 2, $1, false)`,
      [guild.guildId],
    );

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
  });

  it("sends nothing for an event whose forum was removed from the list", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_config_change($1, 2, $1, NULL, '{}'::text[], ARRAY[$2]::text[])`,
      [guild.guildId, guild.channelId],
    );

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
  });

  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await run([]);
    expect(requests).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
    // Every earlier test's guild is left out too.
    expect(
      (await jobRow()).results.event_guilds_not_allowed,
    ).toBeGreaterThanOrEqual(1);
  });

  it("names an event whose post is gone, and sends nothing", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await database.query(
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
      [made.eventId],
    );

    await run([guild]);

    expect(posts()).toEqual([]);
    expect((await jobRow()).results).toMatchObject({
      events_stopped: 1,
      missing_event_ids: [made.eventId],
    });
  });
});

describe("a thread that refuses the bot", () => {
  const refuse = (threadId: string) => (method: string, path: string) =>
    method === "POST" && path.includes(threadId)
      ? Response.json({ code: 50001 }, { status: 403 })
      : undefined;

  it("counts the refusal, keeps the claim and fails the run", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    const other = await event(guild, 4);
    discordGate = refuse(made.threadId);

    const result = await run([guild]);

    expect(result).toMatchObject({ error: "reminders_incomplete" });
    expect(sent.map((message) => message.threadId)).toEqual([other.threadId]);
    expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);
    expect((await jobRow()).results).toMatchObject({
      channels_inaccessible: 1,
    });
    expect(logLines.join("\n")).toContain(made.eventId);
  });
});

describe("limits shared with task reminders", () => {
  it("stops at the message cap and still succeeds", async () => {
    const guild = await guildInUtc();
    await event(guild, 4);
    await event(guild, 5);

    const result = await run([guild], { maxMessages: 1 });

    expect(result.status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect((await jobRow()).results).toMatchObject({ deferred_cap: 1 });
  });

  it("refuses text Discord will not take, records it skipped, and goes on", async () => {
    const guild = await guildInUtc();
    const refused = await event(guild, 4);
    const other = await event(guild, 5);
    discordGate = (method, path) =>
      method === "POST" && path.includes(refused.threadId)
        ? Response.json({ code: 50035 }, { status: 400 })
        : undefined;

    const result = await run([guild]);

    expect(result.status).toBe("succeeded");
    expect(sent.map((message) => message.threadId)).toEqual([other.threadId]);
    expect(await logRows(refused.eventId)).toMatchObject([
      { state: "skipped" },
    ]);
    expect((await jobRow()).results).toMatchObject({ event_items_refused: 1 });
  });
});
