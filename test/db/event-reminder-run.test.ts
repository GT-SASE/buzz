/**
 * The event workflow reminders, run as part of the daily reminder run against the real
 * schema, with Discord mocked at `fetch`. The database's own functions decide every
 * claim, including which days a pickup reminder may be claimed for.
 */

import { describe, expect, it } from "bun:test";
import {
  assignEventStep,
  completeEventStep,
  setEventPickupTime,
} from "../../src/db/event-steps.ts";
import type {
  AssignableStepKind,
  CompletableStepKind,
} from "../../src/db/types.ts";
import type { WorkflowGuildFixture } from "./fixtures.ts";
import { fakeId, present, queryAs } from "./harness.ts";
import { dateOffset, useReminderWorld } from "./reminder-world.ts";

const w = useReminderWorld();

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
  const threadId = w.addThread(guild);
  const rows = await queryAs<{ id: string }>(
    w.database,
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
  await ok(assignEventStep(w.db, { ...stepOf(made), kind, userId }));
  return userId;
}

async function complete(
  made: EventFixture,
  ...kinds: CompletableStepKind[]
): Promise<void> {
  for (const kind of kinds) {
    await ok(completeEventStep(w.db, { ...stepOf(made), kind }));
  }
}

async function pickupAt(made: EventFixture, pickupTime: string): Promise<void> {
  await ok(setEventPickupTime(w.db, { ...stepOf(made), pickupTime }));
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
  const { rows } = await w.database.query<{
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
  return (await w.jobRow()).results;
}

/** A daily step list claim on the given date, left by a run that crashed. */
async function claimAgo(
  eventId: string,
  reminderDate: string,
  minutes: number,
): Promise<void> {
  await w.database.query(
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
    w.database,
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

describe("the daily step list", () => {
  it("pings each open step's people, lists approval without a ping, and marks sent", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 5);
    const budget = [
      await assign(made, "budget_sheet"),
      await assign(made, "budget_sheet"),
    ];
    const engage = await assign(made, "engage_post");

    expect((await w.run([guild])).status).toBe("succeeded");

    expect(w.sent).toHaveLength(1);
    const message = present(w.sent[0]);
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
    const guild = await w.guildInZone();
    const made = await event(guild, 3);
    await assign(made, "budget_sheet");
    await complete(made, "budget_sheet");

    await w.run([guild]);

    const message = present(w.sent[0]);
    expect(message.content).not.toContain("Budget Sheet");
    expect(message.content).toContain(
      `Engage post: nobody is on it yet, <@&${guild.officerRoleId}>`,
    );
    expect(message.users).toEqual([]);
    expect(message.roles).toEqual([guild.officerRoleId]);
  });

  it("goes out on the event's day, and not after it", async () => {
    const guild = await w.guildInZone();
    const today = await event(guild, 0);
    const past = await event(guild, -1);

    await w.run([guild]);

    expect(w.sent.map((message) => message.threadId)).toEqual([today.threadId]);
    expect(present(w.sent[0]).content).toContain("today");
    expect(await logRows(past.eventId)).toEqual([]);
  });

  it("makes no second post, nor any request, on a rerun the same day", async () => {
    const guild = await w.guildInZone();
    await event(guild, 5);

    expect((await w.run([guild])).status).toBe("succeeded");
    w.requests = [];
    expect((await w.run([guild])).status).toBe("duplicate");
    expect(w.requests).toEqual([]);
    expect(w.sent).toHaveLength(1);
  });
});

describe("Food pickup reminders", () => {
  it("pings every pickup person two days before, with the time", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 2, "Movie night");
    const people = await readyForPickup(made, [fakeId(), fakeId()]);

    await w.run([guild]);

    expect(w.sent).toHaveLength(1);
    const message = present(w.sent[0]);
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
    const guild = await w.guildInZone();
    const made = await event(guild, 0);
    await complete(made, "budget_sheet", "engage_post");
    const person = await assign(made, "food_pickup");
    await pickupAt(made, "09:05");

    await w.run([guild]);

    expect(w.sent).toHaveLength(2);
    const time = Date.parse(`${dateOffset(0)}T09:05:00Z`) / 1000;
    const pickup = present(
      w.sent.find((message) =>
        message.content.includes(`<t:${String(time)}:t>`),
      ),
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
      const guild = await w.guildInZone();
      const made = await event(guild, days);
      await readyForPickup(made);

      await w.run([guild]);

      expect(w.posts()).toEqual([]);
      expect(await logRows(made.eventId)).toEqual([]);
    },
  );
});

describe("claims left by an earlier run", () => {
  it("takes over a stale claim and sends it once, but waits on a fresh one", async () => {
    const guild = await w.guildInZone();
    const stale = await event(guild, 4);
    const fresh = await event(guild, 4);
    await claimAgo(stale.eventId, dateOffset(0), 90);
    await claimAgo(fresh.eventId, dateOffset(0), 1);

    expect(await w.run([guild])).toMatchObject({
      error: "reminders_incomplete",
    });
    expect(w.sent.map((message) => message.threadId)).toEqual([stale.threadId]);
    expect(await logRows(stale.eventId)).toMatchObject([
      { state: "sent", attempts: 2 },
    ]);
    expect(await logRows(fresh.eventId)).toMatchObject([{ state: "claimed" }]);
  });

  it("closes yesterday's stale claim as skipped, and sends today's", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 4);
    await claimAgo(made.eventId, dateOffset(-1), 24 * 60);

    await w.run([guild]);

    expect(w.sent).toHaveLength(1);
    expect(await logRows(made.eventId)).toMatchObject([
      { reminder_date: dateOffset(-1), state: "skipped" },
      { reminder_date: dateOffset(0), state: "sent" },
    ]);
  });

  it.each(pauses)(
    "keeps a stale claim while %s, and sends it once that is undone",
    async (_label, pause) => {
      const guild = await w.guildInZone();
      const made = await event(guild, 4);
      await claimAgo(made.eventId, dateOffset(0), 90);
      await pause(guild, false);

      expect((await w.run([guild])).status).toBe("succeeded");
      expect(w.posts()).toEqual([]);
      expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);

      await pause(guild, true);
      // Lets another run start in this slot, as after a failed run.
      await w.database.query(
        `UPDATE public.job_runs SET status = 'failed', error = 'test' WHERE job_name = 'reminders'`,
      );
      await w.run([guild]);

      expect(w.sent).toHaveLength(1);
      expect(await logRows(made.eventId)).toMatchObject([
        { state: "sent", attempts: 2 },
      ]);
    },
  );

  it("sends without pings from the third attempt", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 4);
    const person = await assign(made, "budget_sheet");
    await claimAgo(made.eventId, dateOffset(0), 90);
    await w.database.query(
      `UPDATE public.event_reminder_log SET attempts = 2 WHERE event_id = $1`,
      [made.eventId],
    );

    await w.run([guild]);

    const message = present(w.sent[0]);
    expect(message.users).toEqual([]);
    expect(message.roles).toEqual([]);
    expect(message.content).toContain(`<@${person}>`);
  });
});

describe("what stops event reminders", () => {
  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 4);
    await w.run([]);
    expect(w.requests).toEqual([]);
    expect(await logRows(made.eventId)).toEqual([]);
    // Every earlier test's guild is left out too.
    expect(
      (await jobResults()).event_guilds_not_allowed,
    ).toBeGreaterThanOrEqual(1);
  });

  it("names an event whose post is gone, and sends nothing", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 4);
    await w.database.query(
      `UPDATE public.events SET thread_status = 'missing' WHERE id = $1`,
      [made.eventId],
    );

    await w.run([guild]);

    expect(w.posts()).toEqual([]);
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
      const guild = await w.guildInZone();
      const made = await event(guild, 4);
      const other = await event(guild, 5);
      w.discordGate = failPost(made.threadId, status, code);

      expect<string>((await w.run([guild])).status).toBe(runStatus);
      expect(w.sent.map((message) => message.threadId)).toEqual([
        other.threadId,
      ]);
      expect(await logRows(made.eventId)).toMatchObject([{ state }]);
    },
  );
});
