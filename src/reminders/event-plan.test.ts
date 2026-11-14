import { describe, expect, it } from "vitest";
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
const CREATOR = fakeId(2);
const ROLE = fakeId(3);
const ALICE = fakeId(10);
const BOB = fakeId(11);

type Status = "open" | "done";

function candidate(
  overrides: Partial<EventReminderCandidate> = {},
  done: readonly EventStepKind[] = [],
): EventReminderCandidate {
  const status = (kind: EventStepKind): Status =>
    done.includes(kind) ? "done" : "open";
  return {
    id: EVENT_ID,
    guild_id: fakeId(4),
    name: "Spring social",
    event_date: date("2026-11-20"),
    thread_id: THREAD,
    thread_status: "active",
    created_by: CREATOR,
    pickup_time: null,
    timezone: "America/New_York",
    events_director_role_id: ROLE,
    steps: (
      ["budget_sheet", "engage_post", "budget_approved", "food_pickup"] as const
    ).map((kind) => ({ kind, status: status(kind) })),
    assignees: [],
    log: [],
    ...overrides,
  };
}

const ALL_DONE: EventStepKind[] = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
];

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
  it("lists Budget Sheet, Engage post and Budget approved while they are open", () => {
    expect(openSteps(candidate())).toEqual([
      { kind: "budget_sheet", assigneeIds: [] },
      { kind: "engage_post", assigneeIds: [] },
      { kind: "budget_approved" },
    ]);
  });

  it("names each step's people, oldest first, once each", () => {
    const event = candidate({
      assignees: [
        { kind: "budget_sheet", user_id: BOB },
        { kind: "engage_post", user_id: ALICE },
        { kind: "budget_sheet", user_id: ALICE },
        { kind: "food_pickup", user_id: BOB },
      ],
    });
    expect(openSteps(event).slice(0, 2)).toEqual([
      { kind: "budget_sheet", assigneeIds: [BOB, ALICE] },
      { kind: "engage_post", assigneeIds: [ALICE] },
    ]);
  });

  it("never lists Food pickup, set up or not", () => {
    expect(
      openSteps(
        candidate({}, ["budget_sheet", "engage_post", "budget_approved"]),
      ),
    ).toEqual([]);
  });

  it("keeps listing Budget Sheet after approval if it is still open", () => {
    expect(
      openSteps(candidate({}, ["budget_approved"])).map((step) => step.kind),
    ).toEqual(["budget_sheet", "engage_post"]);
  });

  it("is empty when everything is done", () => {
    expect(openSteps(candidate({}, ALL_DONE))).toEqual([]);
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

  it("gives no step list when only Food pickup is open", () => {
    expect(
      kindsDueToday(
        candidate({ event_date: date("2026-11-15") }, [
          "budget_sheet",
          "engage_post",
          "budget_approved",
        ]),
        TODAY,
      ),
    ).toEqual([]);
  });

  it("gives the step list while anything is open, up to the event's day", () => {
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-15") }), TODAY),
    ).toEqual(["daily_steps"]);
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-14") }), TODAY),
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
    const result = plan([candidate()]);
    expect(result.sends).toEqual([
      {
        ref: { eventId: EVENT_ID, kind: "daily_steps", reminderDate: TODAY },
        threadId: THREAD,
      },
    ]);
    expect(result.skips).toEqual([]);
    expect(result.freshClaims).toEqual([]);
  });

  it("plans nothing when everything is done and nothing is due", () => {
    expect(plan([candidate({}, ALL_DONE)])).toEqual({
      sends: [],
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

  it("treats an unreadable claim time as stale", () => {
    expect(
      plan([
        candidate({
          log: [logRow("daily_steps", "claimed", new Date(Number.NaN))],
        }),
      ]).sends,
    ).toHaveLength(1);
  });

  it("skips a stale claim from an earlier day, and one on a finished list", () => {
    const yesterday = date("2026-11-14");
    const result = plan([
      candidate({
        log: [logRow("daily_steps", "claimed", STALE, yesterday)],
      }),
      candidate(
        {
          id: "22222222-2222-4222-8222-222222222222",
          log: [logRow("daily_steps", "claimed", STALE)],
        },
        ALL_DONE,
      ),
    ]);
    expect(result.skips).toEqual([
      { eventId: EVENT_ID, kind: "daily_steps", reminderDate: yesterday },
      {
        eventId: "22222222-2222-4222-8222-222222222222",
        kind: "daily_steps",
        reminderDate: TODAY,
      },
    ]);
    expect(result.sends).toHaveLength(1);
  });

  it("does not skip a fresh claim from an earlier day", () => {
    expect(
      plan([
        candidate({
          log: [logRow("daily_steps", "claimed", FRESH, date("2026-11-14"))],
        }),
      ]).skips,
    ).toEqual([]);
  });

  it("names an event whose post is gone, only if something is due", () => {
    expect(
      plan([candidate({ thread_status: "missing", thread_id: null })])
        .missingThreadEventIds,
    ).toEqual([EVENT_ID]);
    expect(
      plan([candidate({ thread_status: "missing" }, ALL_DONE)])
        .missingThreadEventIds,
    ).toEqual([]);
  });

  it("skips the stale claims of an event whose post is gone, and no fresh one", () => {
    const result = plan([
      candidate({
        thread_status: "missing",
        thread_id: null,
        log: [
          logRow("daily_steps", "claimed", STALE),
          logRow("pickup_day", "claimed", FRESH),
        ],
      }),
    ]);
    expect(result.sends).toEqual([]);
    expect(result.skips).toEqual([
      { eventId: EVENT_ID, kind: "daily_steps", reminderDate: TODAY },
    ]);
  });

  it("sends nothing to an event whose post is not made yet", () => {
    const result = plan([
      candidate({ thread_status: "pending", thread_id: null }),
    ]);
    expect(result.sends).toEqual([]);
    expect(result.missingThreadEventIds).toEqual([]);
  });

  it("refuses an invalid today or now", () => {
    expect(() =>
      planEventReminders({
        today: "2026-02-30" as DateOnly,
        now: NOW,
        events: [],
      }),
    ).toThrow(RangeError);
    expect(() =>
      planEventReminders({
        today: TODAY,
        now: new Date(Number.NaN),
        events: [],
      }),
    ).toThrow(RangeError);
  });
});
