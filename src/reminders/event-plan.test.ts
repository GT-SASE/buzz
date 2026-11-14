import { describe, expect, it } from "bun:test";
import type {
  EventReminderCandidate,
  EventReminderKind,
  EventStepKind,
} from "../db/types.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  kindsDueToday,
  openSteps,
  pickupPeople,
  planEventReminders,
} from "./event-plan.ts";
import { STALE_CLAIM_MS } from "./plan.ts";
import { fakeId } from "../../test/support/ids.ts";

function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) {
    throw new Error("bad test date");
  }
  return parsed;
}

const NOW = new Date("2026-11-15T15:00:00Z");
const TODAY = date("2026-11-15");
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const THREAD = fakeId(1);
const ALICE = fakeId(10);
const BOB = fakeId(11);
const ALL_DONE: EventStepKind[] = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
];
const ONLY_PICKUP_OPEN: EventStepKind[] = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
];

function candidate(
  overrides: Partial<EventReminderCandidate> = {},
  done: readonly EventStepKind[] = [],
): EventReminderCandidate {
  return {
    id: EVENT_ID,
    guild_id: fakeId(4),
    name: "Spring social",
    event_date: date("2026-11-20"),
    thread_id: THREAD,
    thread_status: "active",
    created_by: fakeId(2),
    pickup_time: null,
    timezone: "America/New_York",
    events_director_role_id: fakeId(3),
    steps: ALL_DONE.map((kind) => ({
      kind,
      status: done.includes(kind) ? "done" : "open",
    })),
    assignees: [],
    log: [],
    ...overrides,
  };
}

/** Everything done and Food pickup set up with Alice at 17:30. */
function pickupReady(eventDate: string): EventReminderCandidate {
  return candidate(
    {
      event_date: date(eventDate),
      pickup_time: "17:30",
      assignees: [{ kind: "food_pickup", user_id: ALICE }],
    },
    ALL_DONE,
  );
}

function logRow(
  kind: EventReminderKind,
  state: "claimed" | "sent" | "skipped",
  claimedAt: Date,
  reminderDate: DateOnly = TODAY,
) {
  return { kind, reminder_date: reminderDate, state, claimed_at: claimedAt };
}

const STALE = new Date(NOW.getTime() - STALE_CLAIM_MS - 1);
const FRESH = new Date(NOW.getTime() - 60_000);

describe("openSteps", () => {
  it("names each open step's people, oldest first, and never Food pickup", () => {
    const event = candidate({
      assignees: [
        { kind: "budget_sheet", user_id: BOB },
        { kind: "engage_post", user_id: ALICE },
        { kind: "budget_sheet", user_id: ALICE },
        { kind: "food_pickup", user_id: BOB },
      ],
    });
    expect(openSteps(event)).toEqual([
      { kind: "budget_sheet", assigneeIds: [BOB, ALICE] },
      { kind: "engage_post", assigneeIds: [ALICE] },
      { kind: "budget_approved" },
    ]);
    expect(openSteps(candidate({}, ONLY_PICKUP_OPEN))).toEqual([]);
  });
});

describe("pickupPeople", () => {
  it("is null until Food pickup is done with a time and people", () => {
    expect(pickupPeople(candidate())).toBeNull();
    expect(
      pickupPeople(candidate({ pickup_time: "17:30" }, ALL_DONE)),
    ).toBeNull();
    expect(pickupPeople(pickupReady("2026-11-17"))).toEqual([ALICE]);
  });
});

describe("kindsDueToday", () => {
  it.each<[string, EventReminderKind[]]>([
    ["2026-11-14", []],
    ["2026-11-15", ["pickup_day"]],
    ["2026-11-16", []],
    ["2026-11-17", ["pickup_before"]],
    ["2026-11-18", []],
  ])("for a ready event on %s gives %j", (eventDate, kinds) => {
    expect(kindsDueToday(pickupReady(eventDate), TODAY)).toEqual(kinds);
  });

  it("gives the step list while a step is open, up to the event's day", () => {
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-15") }), TODAY),
    ).toEqual(["daily_steps"]);
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-14") }), TODAY),
    ).toEqual([]);
    expect(
      kindsDueToday(
        candidate({ event_date: date("2026-11-15") }, ONLY_PICKUP_OPEN),
        TODAY,
      ),
    ).toEqual([]);
  });

  it("gives no pickup reminder until Food pickup is set up", () => {
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-17") }), TODAY),
    ).toEqual(["daily_steps"]);
  });
});

describe("planEventReminders", () => {
  const plan = (events: EventReminderCandidate[]) =>
    planEventReminders({ today: TODAY, now: NOW, events });

  it("sends today's reminders to the event's thread", () => {
    expect(plan([candidate()])).toEqual({
      sends: [
        {
          ref: { eventId: EVENT_ID, kind: "daily_steps", reminderDate: TODAY },
          threadId: THREAD,
        },
      ],
      skips: [],
      freshClaims: [],
      missingThreadEventIds: [],
    });
  });

  it("leaves what was sent or skipped today alone", () => {
    for (const state of ["sent", "skipped"] as const) {
      const result = plan([
        candidate({ log: [logRow("daily_steps", state, FRESH)] }),
      ]);
      expect(result.sends).toEqual([]);
    }
  });

  it("takes over a stale claim and waits on a fresh one", () => {
    expect(
      plan([candidate({ log: [logRow("daily_steps", "claimed", STALE)] })])
        .sends,
    ).toHaveLength(1);
    const fresh = plan([
      candidate({ log: [logRow("daily_steps", "claimed", FRESH)] }),
    ]);
    expect(fresh.sends).toEqual([]);
    expect(fresh.freshClaims).toEqual([
      { eventId: EVENT_ID, kind: "daily_steps", reminderDate: TODAY },
    ]);
  });

  it("skips a stale claim from an earlier day, but not a fresh one", () => {
    const yesterday = date("2026-11-14");
    expect(
      plan([
        candidate({
          log: [logRow("daily_steps", "claimed", STALE, yesterday)],
        }),
      ]).skips,
    ).toEqual([
      { eventId: EVENT_ID, kind: "daily_steps", reminderDate: yesterday },
    ]);
    expect(
      plan([
        candidate({
          log: [logRow("daily_steps", "claimed", FRESH, yesterday)],
        }),
      ]).skips,
    ).toEqual([]);
  });

  it("names an event whose post is gone only if something is due, and sends to no pending post", () => {
    expect(
      plan([candidate({ thread_status: "missing", thread_id: null })])
        .missingThreadEventIds,
    ).toEqual([EVENT_ID]);
    expect(
      plan([candidate({ thread_status: "missing" }, ALL_DONE)])
        .missingThreadEventIds,
    ).toEqual([]);
    const pending = plan([
      candidate({ thread_status: "pending", thread_id: null }),
    ]);
    expect(pending.sends).toEqual([]);
    expect(pending.missingThreadEventIds).toEqual([]);
  });
});
