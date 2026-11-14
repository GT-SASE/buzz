/**
 * The event workflow reminders, run as part of the daily reminder run against the real
 * schema, with Discord mocked at `fetch`. The database's own functions decide every
 * claim, including which days a pickup reminder may be claimed for.
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
import { pgliteSql } from "../support/sql-client.ts";
import { stubGlobal } from "../support/stubs.ts";
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
import { runReminders, type RunLimits } from "../../src/reminders/run.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { messageBody, type MessageBody } from "../support/json.ts";
import { insertGuild, type WorkflowGuildFixture } from "./fixtures.ts";
import { createMigratedDb, fakeId, present, queryAs } from "./harness.ts";

const API = "https://discord.com/api/v10";

let database: PGlite;
let db: DbClient;
/** Answers a request in place of the default, or leaves it to the default. */
let discordGate: (method: string, path: string) => Response | undefined;
let requests: { method: string; path: string }[];
let sent: (MessageBody & { threadId: string })[];
let threadGuilds: Map<string, WorkflowGuildFixture>;
let logLines: string[];

function posts() {
  return requests.filter((request) => request.method === "POST");
}

function run(
  guilds: readonly WorkflowGuildFixture[],
  limits?: Partial<RunLimits>,
  now?: Date,
) {
  return runReminders({
    db,
    client: createDiscordClient({
      check: managedChannelCheck(db),
      env: { DISCORD_BOT_TOKEN: "unit-test-token", DISCORD_APP_ID: fakeId() },
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
  guildId: string;
  eventId: string;
  threadId: string;
}

async function event(
  guild: WorkflowGuildFixture,
  days: number,
  name = "Spring social",
): Promise<EventFixture> {
  const threadId = fakeId();
  threadGuilds.set(threadId, guild);
  const rows = await queryAs<{ id: string }>(
    database,
    "bot_app",
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING id`,
    [
      guild.guildId,
      guild.channelId,
      name,
      dateOffset(days),
      fakeId(),
      threadId,
    ],
  );
  return { guildId: guild.guildId, eventId: present(rows[0]).id, threadId };
}

/** Who and what a step command acts on, as a fresh officer. */
function stepOf(made: EventFixture) {
  return { guildId: made.guildId, eventId: made.eventId, actorId: fakeId() };
}

async function ok(result: Promise<unknown>): Promise<void> {
  expect(await result).toEqual({ ok: true, value: true });
}

async function assign(
  made: EventFixture,
  kind: AssignableStepKind,
  userId = fakeId(),
): Promise<string> {
  await ok(assignEventStep(db, { ...stepOf(made), kind, userId }));
  return userId;
}

async function complete(
  made: EventFixture,
  ...kinds: CompletableStepKind[]
): Promise<void> {
  for (const kind of kinds) {
    await ok(completeEventStep(db, { ...stepOf(made), kind }));
  }
}

async function pickupAt(made: EventFixture, pickupTime: string): Promise<void> {
  await ok(setEventPickupTime(db, { ...stepOf(made), pickupTime }));
}

/** Budget Sheet, Engage post and Budget approved done, and Food pickup set up. */
async function readyForPickup(
  made: EventFixture,
  people = [fakeId()],
): Promise<string[]> {
  await complete(made, "budget_sheet", "engage_post", "budget_approved");
  for (const person of people) {
    await assign(made, "food_pickup", person);
  }
  await pickupAt(made, "17:30");
  return people;
}

async function logRows(eventId: string) {
  const { rows } = await database.query<{
    kind: string;
    reminder_date: string;
    state: string;
    attempts: number;
  }>(
    `SELECT kind, to_char(reminder_date, 'YYYY-MM-DD') AS reminder_date, state, attempts
     FROM public.event_reminder_log WHERE event_id = $1 ORDER BY kind, reminder_date`,
    [eventId],
  );
  return rows;
}

async function jobResults(): Promise<Record<string, unknown>> {
  const { rows } = await database.query<{ results: Record<string, unknown> }>(
    `SELECT results FROM public.job_runs
     WHERE job_name = 'reminders' ORDER BY started_at DESC LIMIT 1`,
  );
  return present(rows[0]).results;
}

/** A daily step list claim on the given date, left by a run that crashed. */
async function claimAgo(
  eventId: string,
  reminderDate: string,
  minutes: number,
): Promise<void> {
  await database.query(
    `INSERT INTO public.event_reminder_log (event_id, kind, reminder_date, claimed_at)
     VALUES ($1, 'daily_steps', $2, now() - make_interval(mins => $3))`,
    [eventId, reminderDate, minutes],
  );
}

/** Applies a /config change: reminders on or off, then forums to add and remove. */
async function configChange(
  guild: WorkflowGuildFixture,
  ...change: [boolean | null, string[], string[]]
): Promise<void> {
  await queryAs(
    database,
    "bot_app",
    `SELECT public.apply_config_change($1,
       (SELECT version FROM public.guild_config WHERE guild_id = $1), $1, $2,
       $3::text[], $4::text[])`,
    [guild.guildId, ...change],
  );
}

/** Ways a guild stops its event reminders, each undone by passing true. */
const pauses = [
  [
    "reminders are off",
    (guild: WorkflowGuildFixture, on: boolean) =>
      configChange(guild, on, [], []),
  ],
  [
    "its forum is unmanaged",
    (guild: WorkflowGuildFixture, on: boolean) =>
      on
        ? configChange(guild, null, [guild.channelId], [])
        : configChange(guild, null, [], [guild.channelId]),
  ],
] as const;

/** Answers a POST to one thread with a Discord error. */
function failPost(threadId: string, status: number, code: number) {
  return (method: string, path: string) =>
    method === "POST" && path.includes(threadId)
      ? Response.json({ code }, { status })
      : undefined;
}

beforeAll(async () => {
  database = await createMigratedDb();
  db = createDbClient(pgliteSql(database));
});

afterAll(() => database.close());

beforeEach(async () => {
  discordGate = () => undefined;
  requests = [];
  sent = [];
  threadGuilds = new Map();
  logLines = [];
  stubGlobal("fetch", (url: string, init?: RequestInit) => {
    if (!url.startsWith(API)) {
      throw new Error(`Unexpected request to ${url}`);
    }
    const path = url.slice(API.length);
    const method = init?.method ?? "GET";
    requests.push({ method, path });
    const id = /^\/channels\/([0-9]+)/.exec(path)?.[1] ?? "";
    const answer = discordGate(method, path);
    if (answer !== undefined) {
      return Promise.resolve(answer);
    }
    if (method === "POST") {
      sent.push({ threadId: id, ...messageBody(init?.body) });
      return Promise.resolve(Response.json({ id: fakeId() }));
    }
    const guild = threadGuilds.get(id);
    return Promise.resolve(
      Response.json(
        guild === undefined
          ? { id, type: 15, guild_id: "0" }
          : {
              id,
              type: 11,
              guild_id: guild.guildId,
              parent_id: guild.channelId,
            },
      ),
    );
  });
  // Events from earlier tests stay, but in guilds no later test allows.
  await database.exec(`
    DELETE FROM public.event_reminder_log;
    DELETE FROM public.job_runs;
  `);
});

describe("the daily step list", () => {
  it("pings each open step's people, lists approval without a ping, and marks sent", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 5);
    const budget = [
      await assign(made, "budget_sheet"),
      await assign(made, "budget_sheet"),
    ];
    const engage = await assign(made, "engage_post");

    expect((await run([guild])).status).toBe("succeeded");

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
    expect(message.content).not.toMatch(/food pickup/i);
    expect(message.content).toContain("in 5 days");
    expect(await logRows(made.eventId)).toMatchObject([
      { kind: "daily_steps", reminder_date: dateOffset(0), state: "sent" },
    ]);
  });

  it("leaves out finished steps and pings the Events Directors for one nobody is on", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 3);
    await assign(made, "budget_sheet");
    await complete(made, "budget_sheet");

    await run([guild]);

    const message = present(sent[0]);
    expect(message.content).not.toContain("Budget Sheet");
    expect(message.content).toContain(
      `Engage post: nobody is on it yet, <@&${guild.officerRoleId}>`,
    );
    expect(message.users).toEqual([]);
    expect(message.roles).toEqual([guild.officerRoleId]);
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

  it("makes no second post, nor any request, on a rerun the same day", async () => {
    const guild = await guildInUtc();
    await event(guild, 5);

    expect((await run([guild])).status).toBe("succeeded");
    requests = [];
    expect((await run([guild])).status).toBe("duplicate");
    expect(requests).toEqual([]);
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
    const people = await readyForPickup(made);

    await run([guild], undefined, new Date(recovery));

    const pickup = sent.find((message) =>
      message.content.includes("you are on food pickup"),
    );
    expect(present(pickup).users).toEqual(people);
    expect(await logRows(made.eventId)).toMatchObject([
      { kind: "pickup_before", reminder_date: slotDay, state: "sent" },
    ]);
  });

  it("pings every pickup person two days before, with the time", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 2, "Movie night");
    const people = await readyForPickup(made, [fakeId(), fakeId()]);

    await run([guild]);

    expect(sent).toHaveLength(1);
    const message = present(sent[0]);
    expect(message.threadId).toBe(made.threadId);
    expect(message.users.sort()).toEqual([...people].sort());
    expect(message.roles).toEqual([]);
    expect(message.content).toContain("Movie night");
    expect(message.content).toContain(
      `at <t:${String(Date.parse(`${dateOffset(2)}T17:30:00Z`) / 1000)}:t>`,
    );
    expect(message.content).toContain("in 2 days");
    expect(await logRows(made.eventId)).toMatchObject([
      { kind: "pickup_before", reminder_date: dateOffset(0), state: "sent" },
    ]);
  });

  it("pings them again on the day, apart from the step list, before the budget is approved", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 0);
    await complete(made, "budget_sheet", "engage_post");
    const person = await assign(made, "food_pickup");
    await pickupAt(made, "09:05");

    await run([guild]);

    expect(sent).toHaveLength(2);
    const time = Date.parse(`${dateOffset(0)}T09:05:00Z`) / 1000;
    const pickup = present(
      sent.find((message) => message.content.includes(`<t:${String(time)}:t>`)),
    );
    expect(pickup.users).toEqual([person]);
    expect(pickup.content).toContain("today");
    expect((await logRows(made.eventId)).map((row) => row.kind)).toEqual([
      "daily_steps",
      "pickup_day",
    ]);
  });

  it.each([1, 3])(
    "sends nothing %i days before, once only Food pickup is open",
    async (days) => {
      const guild = await guildInUtc();
      const made = await event(guild, days);
      await readyForPickup(made);

      await run([guild]);

      expect(posts()).toEqual([]);
      expect(await logRows(made.eventId)).toEqual([]);
    },
  );
});

describe("a run cut short", () => {
  it("lets the recovery cron send what failed, and not again what went out", async () => {
    const guild = await guildInUtc();
    const good = await event(guild, 4);
    const failing = await event(guild, 4);
    discordGate = failPost(failing.threadId, 404, 0);

    expect(await run([guild])).toMatchObject({
      error: "reminders_incomplete",
    });
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

    expect((await run([guild])).status).toBe("succeeded");
    expect(sent.map((message) => message.threadId)).toEqual([failing.threadId]);
    expect(await logRows(failing.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
    expect(await logRows(good.eventId)).toMatchObject([
      { state: "sent", attempts: 1 },
    ]);
  });

  it("takes over a stale claim and sends it once, but waits on a fresh one", async () => {
    const guild = await guildInUtc();
    const stale = await event(guild, 4);
    const fresh = await event(guild, 4);
    await claimAgo(stale.eventId, dateOffset(0), 90);
    await claimAgo(fresh.eventId, dateOffset(0), 1);

    expect(await run([guild])).toMatchObject({
      error: "reminders_incomplete",
    });
    expect(sent.map((message) => message.threadId)).toEqual([stale.threadId]);
    expect(await logRows(stale.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
    expect(await logRows(fresh.eventId)).toMatchObject([{ state: "claimed" }]);
  });

  it("closes a stale claim as skipped when the event is closed", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, dateOffset(0), 90);
    await database.query(
      `UPDATE public.events SET status = 'closed' WHERE id = $1`,
      [made.eventId],
    );

    await run([guild]);

    expect(posts()).toEqual([]);
    expect(await logRows(made.eventId)).toMatchObject([
      { state: "skipped", attempts: 1 },
    ]);
  });

  it("closes yesterday's stale claim as skipped, and sends today's", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, dateOffset(-1), 24 * 60);

    await run([guild]);

    expect(sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toMatchObject([
      { reminder_date: dateOffset(-1), state: "skipped" },
      { reminder_date: dateOffset(0), state: "sent" },
    ]);
  });

  it.each(pauses)(
    "keeps a stale claim while %s, and sends it once that is undone",
    async (_label, pause) => {
      const guild = await guildInUtc();
      const made = await event(guild, 4);
      await claimAgo(made.eventId, dateOffset(0), 90);
      await pause(guild, false);

      expect((await run([guild])).status).toBe("succeeded");
      expect(posts()).toEqual([]);
      expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);

      await pause(guild, true);
      // Lets another run start in this slot, as after a failed run.
      await database.query(
        `UPDATE public.job_runs SET status = 'failed', error = 'test' WHERE job_name = 'reminders'`,
      );
      await run([guild]);

      expect(sent).toHaveLength(1);
      expect(await logRows(made.eventId)).toMatchObject([
        { state: "sent", attempts: 2 },
      ]);
    },
  );

  it("sends without pings from the third attempt", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    const person = await assign(made, "budget_sheet");
    await claimAgo(made.eventId, dateOffset(0), 90);
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
  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await guildInUtc();
    const made = await event(guild, 4);
    await run([]);
    expect(requests).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
    // Every earlier test's guild is left out too.
    expect(
      (await jobResults()).event_guilds_not_allowed,
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
    expect(await jobResults()).toMatchObject({
      missing_event_ids: [made.eventId],
    });
  });

  it.each([
    ["refuses the bot", "claimed", 403, 50001, "failed"],
    ["will not take the text", "skipped", 400, 50035, "succeeded"],
  ])(
    "when a thread %s, goes on to the others and leaves the claim %s",
    async (_label, state, status, code, runStatus) => {
      const guild = await guildInUtc();
      const made = await event(guild, 4);
      const other = await event(guild, 5);
      discordGate = failPost(made.threadId, status, code);

      expect<string>((await run([guild])).status).toBe(runStatus);
      expect(sent.map((message) => message.threadId)).toEqual([other.threadId]);
      expect(await logRows(made.eventId)).toMatchObject([{ state }]);
    },
  );

  it("stops at the message cap and still succeeds", async () => {
    const guild = await guildInUtc();
    await event(guild, 4);
    await event(guild, 5);

    expect((await run([guild], { maxMessages: 1 })).status).toBe("succeeded");
    expect(sent).toHaveLength(1);
    expect(await jobResults()).toMatchObject({ deferred_cap: 1 });
  });
});
