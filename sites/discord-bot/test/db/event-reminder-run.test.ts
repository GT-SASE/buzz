/**
 * The event workflow reminders, run as part of the daily reminder run against the real
 * schema, with Discord mocked at `fetch`. The database's own functions decide every
 * claim, including which days a pickup reminder may be claimed for.
 */

import { describe, expect, it } from "bun:test";
import {
  assignEventStep,
  completeEventStep,
  reopenEventStep,
  setEventPickupTime,
  setSlidesNotNeeded,
} from "../../src/db/event-steps.ts";
import type {
  AssignableStepKind,
  CompletableStepKind,
  EventReminderKind,
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
    `INSERT INTO discord_bot.events
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
  expect(
    await assignEventStep(w.db, { ...stepOf(made), kind, userId }),
  ).toEqual({ ok: true, value: "added" });
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
     FROM discord_bot.event_reminder_log WHERE event_id = $1 ORDER BY kind, reminder_date`,
    [eventId],
  );
  return rows;
}

async function jobResults(): Promise<Record<string, unknown>> {
  return (await w.jobRow()).results;
}

/** An "is today" claim on the given date, left by a run that crashed. */
async function claimAgo(
  eventId: string,
  reminderDate: string,
  minutes: number,
): Promise<void> {
  await w.database.query(
    `INSERT INTO discord_bot.event_reminder_log (event_id, kind, reminder_date, claimed_at)
     VALUES ($1, 'event_today', $2, now() - make_interval(mins => $3))`,
    [eventId, reminderDate, minutes],
  );
}

async function slidesNotNeeded(made: EventFixture): Promise<void> {
  await ok(setSlidesNotNeeded(w.db, { ...stepOf(made), notNeeded: true }));
}

/** Engage post done at noon on the given date. */
async function engageDoneOn(made: EventFixture, day: string): Promise<void> {
  await complete(made, "engage_post");
  await w.database.query(
    `UPDATE discord_bot.event_steps SET completed_at = $2
     WHERE event_id = $1 AND kind = 'engage_post'`,
    [made.eventId, `${day}T12:00:00Z`],
  );
}

/**
 * The Saturday ping goes by the calendar, so an event a few days out gets one on some
 * days and not others. These leave it out.
 */
function besidesSaturday<Row extends { kind: string }>(rows: Row[]): Row[] {
  return rows.filter((row) => row.kind !== "marketing_saturday");
}

function sentBesidesSaturday(guild: WorkflowGuildFixture) {
  return w.sent.filter(
    (message) => !message.roles.includes(guild.marketingRoleId),
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
    `SELECT discord_bot.apply_config_change($1,
       (SELECT version FROM discord_bot.guild_config WHERE guild_id = $1), $1, $2,
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

type Setup = (
  made: EventFixture,
  guild: WorkflowGuildFixture,
) => Promise<{ users: string[]; roles: string[] }>;

describe("countdown pings", () => {
  it.each<[EventReminderKind, number, Setup, string]>([
    [
      "steps_unassigned",
      35,
      async (made, guild) => {
        await assign(made, "budget_sheet");
        return { users: [], roles: [guild.officerRoleId] };
      },
      "Nobody is on Engage post for **Spring social**.",
    ],
    [
      "budget_due",
      28,
      async (made) => ({
        users: [await assign(made, "budget_sheet")],
        roles: [],
      }),
      "Budget Sheet for **Spring social** is due.",
    ],
    [
      "engage_due",
      28,
      async (made) => ({
        users: [await assign(made, "engage_post")],
        roles: [],
      }),
      "Engage post for **Spring social** is due.",
    ],
    [
      "budget_overdue",
      21,
      async (made, guild) => ({
        users: [await assign(made, "budget_sheet")],
        roles: [guild.officerRoleId],
      }),
      "Budget Sheet for **Spring social** is overdue.",
    ],
    [
      "engage_overdue",
      21,
      async (made, guild) => ({
        users: [await assign(made, "engage_post")],
        roles: [guild.officerRoleId],
      }),
      "Engage post for **Spring social** is overdue.",
    ],
    [
      "engage_picture_late",
      30,
      async (made, guild) => {
        await engageDoneOn(made, dateOffset(-7));
        return { users: [], roles: [guild.marketingRoleId] };
      },
      "Engage picture for **Spring social** hasn't been added yet.",
    ],
    [
      "marketing_week",
      7,
      (_made, guild) =>
        Promise.resolve({ users: [], roles: [guild.marketingRoleId] }),
      "in 7 days.",
    ],
    [
      "slides_unassigned",
      7,
      (_made, guild) =>
        Promise.resolve({ users: [], roles: [guild.officerRoleId] }),
      "Nobody is on Slides for **Spring social**.",
    ],
    [
      "pickup_unset",
      7,
      async (made, guild) => {
        expect(
          await setEventPickupTime(w.db, {
            ...stepOf(made),
            pickupTime: "17:30",
          }),
        ).toEqual({ ok: true, value: false });
        return { users: [], roles: [guild.officerRoleId] };
      },
      "Food pickup for **Spring social** isn't set up: nobody is on it.",
    ],
    [
      "slides_due",
      2,
      async (made) => ({ users: [await assign(made, "slides")], roles: [] }),
      "Slides for **Spring social** are needed for the event on",
    ],
    [
      "slides_tomorrow",
      1,
      async (made) => ({ users: [await assign(made, "slides")], roles: [] }),
      "Slides for **Spring social** are needed for the event tomorrow",
    ],
    [
      "event_today",
      0,
      (_made, guild) =>
        Promise.resolve({
          users: [],
          roles: [guild.officerRoleId, guild.eventsCommitteeRoleId],
        }),
      "**Spring social** is today",
    ],
  ])("sends %s on its day", async (kind, days, setup, text) => {
    const guild = await w.guildInZone();
    const made = await event(guild, days);
    const who = await setup(made, guild);

    expect((await w.run([guild])).status).toBe("succeeded");

    const message = present(w.sent.find((sent) => sent.content.includes(text)));
    expect(message.threadId).toBe(made.threadId);
    expect(message.parse).toEqual([]);
    expect(message.users).toEqual(who.users);
    expect(message.roles.sort()).toEqual(who.roles.sort());
    expect(
      (await logRows(made.eventId)).filter((row) => row.kind === kind),
    ).toMatchObject([{ reminder_date: dateOffset(0), state: "sent" }]);
  });

  it("sends engage_picture_late a week after Engage post, though the event has passed", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, -4);
    await engageDoneOn(made, dateOffset(-7));

    expect((await w.run([guild])).status).toBe("succeeded");

    expect(w.sent.map((sent) => sent.content)).toEqual([
      expect.stringContaining("Engage picture for **Spring social**"),
    ]);
    expect(
      (await logRows(made.eventId)).filter(
        (row) => row.kind === "engage_picture_late",
      ),
    ).toMatchObject([{ reminder_date: dateOffset(0), state: "sent" }]);
  });

  it.each<[EventReminderKind, number, (made: EventFixture) => Promise<void>]>([
    [
      "steps_unassigned",
      35,
      async (made) => {
        await assign(made, "budget_sheet");
        await assign(made, "engage_post");
      },
    ],
    [
      "budget_due",
      28,
      async (made) => {
        await assign(made, "budget_sheet");
        await complete(made, "budget_sheet");
      },
    ],
    ["budget_due", 28, () => Promise.resolve()],
    ["engage_due", 28, () => Promise.resolve()],
    ["budget_overdue", 21, (made) => complete(made, "budget_sheet")],
    ["engage_overdue", 21, (made) => complete(made, "engage_post")],
    [
      "engage_picture_late",
      30,
      async (made) => {
        await engageDoneOn(made, dateOffset(-7));
        await complete(made, "engage_picture");
      },
    ],
    ["slides_unassigned", 7, slidesNotNeeded],
    [
      "pickup_unset",
      7,
      async (made) => {
        await assign(made, "food_pickup");
        await pickupAt(made, "17:30");
      },
    ],
    ["slides_due", 2, () => Promise.resolve()],
    [
      "slides_tomorrow",
      1,
      async (made) => {
        await assign(made, "slides");
        await slidesNotNeeded(made);
      },
    ],
  ])("skips %s when it is not needed", async (kind, days, setup) => {
    const guild = await w.guildInZone();
    const made = await event(guild, days);
    await setup(made);

    expect((await w.run([guild])).status).toBe("succeeded");

    expect((await logRows(made.eventId)).map((row) => row.kind)).not.toContain(
      kind,
    );
  });

  it("sends a due ping again once the step is undone", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 28);
    const user = await assign(made, "budget_sheet");
    await complete(made, "budget_sheet");
    await ok(reopenEventStep(w.db, { ...stepOf(made), kind: "budget_sheet" }));

    expect((await w.run([guild])).status).toBe("succeeded");

    const message = present(
      w.sent.find((sent) => sent.content.includes("Budget Sheet")),
    );
    expect(message.users).toEqual([user]);
  });

  it("sends nothing for a closed event", async () => {
    const guild = await w.guildInZone();
    const events = [await event(guild, 0), await event(guild, 7)];
    await w.database.query(
      `UPDATE discord_bot.events SET status = 'closed' WHERE id = ANY($1)`,
      [events.map((made) => made.eventId)],
    );

    await w.run([guild]);

    expect(w.posts()).toEqual([]);
    for (const made of events) {
      expect(await logRows(made.eventId)).toEqual([]);
    }
  });

  it("sends no daily list, and does not catch up a day already past", async () => {
    const guild = await w.guildInZone();
    // Every step open and nobody on any, 3 to 6 days out: past the week-before pings.
    const events = [
      await event(guild, 3),
      await event(guild, 4),
      await event(guild, 5),
      await event(guild, 6),
    ];

    expect((await w.run([guild])).status).toBe("succeeded");

    expect(sentBesidesSaturday(guild)).toEqual([]);
    for (const made of events) {
      expect(besidesSaturday(await logRows(made.eventId))).toEqual([]);
    }
  });

  it("makes no second post, nor any request, on a rerun the same day", async () => {
    const guild = await w.guildInZone();
    await event(guild, 0);

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

    expect(sentBesidesSaturday(guild)).toHaveLength(1);
    const message = present(sentBesidesSaturday(guild)[0]);
    expect(message.threadId).toBe(made.threadId);
    expect(message.users.sort()).toEqual([...people].sort());
    expect(message.roles).toEqual([]);
    expect(message.content).toContain("Movie night");
    expect(message.content).toContain(
      `at <t:${String(Date.parse(`${dateOffset(2)}T17:30:00Z`) / 1000)}:t>`,
    );
    expect(message.content).toContain("in 2 days");
    expect(besidesSaturday(await logRows(made.eventId))).toMatchObject([
      { kind: "pickup_before", reminder_date: dateOffset(0), state: "sent" },
    ]);
  });

  it("pings them again on the day, apart from the event-day ping, before the budget is approved", async () => {
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
      "pickup_day",
      "event_today",
    ]);
  });

  it.each([1, 3])(
    "sends nothing %i days before, once only Food pickup is open",
    async (days) => {
      const guild = await w.guildInZone();
      const made = await event(guild, days);
      await readyForPickup(made);

      await w.run([guild]);

      expect(sentBesidesSaturday(guild)).toEqual([]);
      expect(besidesSaturday(await logRows(made.eventId))).toEqual([]);
    },
  );
});

describe("claims left by an earlier run", () => {
  it("takes over a stale claim and sends it once, but waits on a fresh one", async () => {
    const guild = await w.guildInZone();
    const stale = await event(guild, 0);
    const fresh = await event(guild, 0);
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
    const made = await event(guild, 0);
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
      const made = await event(guild, 0);
      await claimAgo(made.eventId, dateOffset(0), 90);
      await pause(guild, false);

      expect((await w.run([guild])).status).toBe("succeeded");
      expect(w.posts()).toEqual([]);
      expect(await logRows(made.eventId)).toMatchObject([{ state: "claimed" }]);

      await pause(guild, true);
      // Lets another run start in this slot, as after a failed run.
      await w.database.query(
        `UPDATE discord_bot.job_runs SET status = 'failed', error = 'test' WHERE job_name = 'reminders'`,
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
    const made = await event(guild, 0);
    await claimAgo(made.eventId, dateOffset(0), 90);
    await w.database.query(
      `UPDATE discord_bot.event_reminder_log SET attempts = 2 WHERE event_id = $1`,
      [made.eventId],
    );

    await w.run([guild]);

    const message = present(w.sent[0]);
    expect(message.users).toEqual([]);
    expect(message.roles).toEqual([]);
    expect(message.content).toContain(`<@&${guild.officerRoleId}>`);
  });
});

describe("what stops event reminders", () => {
  it("sends nothing to a guild no longer allowed", async () => {
    const guild = await w.guildInZone();
    const made = await event(guild, 0);
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
    const made = await event(guild, 0);
    await w.database.query(
      `UPDATE discord_bot.events SET thread_status = 'missing' WHERE id = $1`,
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
      const made = await event(guild, 0);
      const other = await event(guild, 0);
      w.discordGate = failPost(made.threadId, status, code);

      expect<string>((await w.run([guild])).status).toBe(runStatus);
      expect(w.sent.map((message) => message.threadId)).toEqual([
        other.threadId,
      ]);
      expect(await logRows(made.eventId)).toMatchObject([{ state }]);
    },
  );
});
