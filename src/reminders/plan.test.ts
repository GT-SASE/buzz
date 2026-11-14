import { describe, expect, it } from "bun:test";
import type {
  EventReminderCandidate,
  EventReminderKind,
  EventStepKind,
} from "../db/types.ts";
import { parseIsoDate, todayInZone, type DateOnly } from "../lib/dates.ts";
import { fakeId } from "../../test/support/ids.ts";
import { kindsDueToday, planEventReminders } from "./event-plan.ts";
import {
  dayRunStart,
  planReminders,
  REMINDER_KINDS,
  STALE_CLAIM_MS,
  type PlanEvent,
  type PlanInput,
  type PlanTask,
  type ReminderKind,
  type ReminderLogRow,
  type ReminderPlan,
  type ReminderState,
  SLOT_START_HOUR_UTC,
  slotStart,
  slotToday,
} from "./plan.ts";

const NEW_YORK = "America/New_York";
const NOW = new Date("2026-11-15T14:00:00Z");
const TODAY = "2026-11-15";
const TASK_ID = "task-1";
const EVENT_ID = "event-1";
const THREAD_ID = "thread-1";

function date(value: string): DateOnly {
  const result = parseIsoDate(value);
  if (result === null) {
    throw new Error(`Bad date in test: ${value}`);
  }
  return result;
}

function event(overrides: Partial<PlanEvent> = {}): PlanEvent {
  return {
    id: EVENT_ID,
    threadId: THREAD_ID,
    status: "active",
    threadStatus: "active",
    deleted: false,
    forumManaged: true,
    ...overrides,
  };
}

function task(due: string, overrides: Partial<PlanTask> = {}): PlanTask {
  return {
    id: TASK_ID,
    eventId: EVENT_ID,
    dueDate: date(due),
    status: "open",
    deleted: false,
    ...overrides,
  };
}

function row(
  due: string,
  kind: ReminderKind,
  state: ReminderState,
  claimedAt: Date = new Date("2026-11-01T14:00:00Z"),
  taskId: string = TASK_ID,
): ReminderLogRow {
  return { taskId, dueDate: date(due), kind, state, claimedAt };
}

function ageAgo(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function plan(overrides: Partial<PlanInput> = {}): ReminderPlan {
  return planReminders({
    today: date(TODAY),
    now: NOW,
    remindersEnabled: true,
    events: [event()],
    tasks: [task(TODAY)],
    log: [],
    ...overrides,
  });
}

/** Sends for a single task, flattened, for tests that do not care about groups. */
function kindsSent(result: ReminderPlan): ReminderKind[] {
  return result.events.flatMap((group) =>
    group.reminders.map((reminder) => reminder.kind),
  );
}

function kindsSkipped(result: ReminderPlan): ReminderKind[] {
  return result.skips.map((skip) => skip.kind);
}

/** Drops the branded date types, so a plan compares with plain strings. */
function plain(value: unknown): unknown {
  return value;
}

const NOTHING: ReminderPlan = {
  events: [],
  skips: [],
  freshClaims: [],
  missingThreadEventIds: [],
  invalidTaskIds: [],
};

interface DayResult {
  today: string;
  sent: ReminderKind[];
  skipped: ReminderKind[];
}

/**
 * Runs the planner at each instant, feeding what it decided back in as log rows the way
 * the runner will, so a test can watch a task's whole life.
 */
function simulate(due: string, instants: readonly string[]): DayResult[] {
  const log: ReminderLogRow[] = [];
  return instants.map((instant) => {
    const now = new Date(instant);
    const today = todayInZone(now, NEW_YORK);
    const result = plan({ today, now, tasks: [task(due)], log });
    log.push(
      ...result.events
        .flatMap((group) => group.reminders)
        .map((ref) => ({ ...ref, state: "sent" as const, claimedAt: now })),
      ...result.skips.map((ref) => ({
        ...ref,
        state: "skipped" as const,
        claimedAt: now,
      })),
    );
    return { today, sent: kindsSent(result), skipped: kindsSkipped(result) };
  });
}

describe("reminder windows", () => {
  it.each<[string, string, ReminderKind | null, ReminderKind[]]>([
    ["4 days before", "2026-11-19", null, []],
    ["2 days before, after a missed run", "2026-11-17", "three_days", []],
    ["the due day", "2026-11-15", "due_day", ["three_days", "one_day"]],
    [
      "a year overdue",
      "2025-11-15",
      "overdue",
      ["three_days", "one_day", "due_day"],
    ],
  ])("on a task with no history, %s", (_name, due, sends, skips) => {
    const result = plan({ tasks: [task(due)] });

    expect(kindsSent(result)).toEqual(sends === null ? [] : [sends]);
    expect(kindsSkipped(result)).toEqual(skips);
  });
});

describe("catch-up after a missed run", () => {
  it.each<[string, string, ReminderLogRow[], ReminderKind[], ReminderKind[]]>([
    [
      "one_day and due_day missed, now overdue",
      "2026-11-10",
      [row("2026-11-10", "three_days", "sent")],
      ["overdue"],
      ["one_day", "due_day"],
    ],
    [
      "a hole below a sent kind is filled in without sending it",
      "2026-11-14",
      [row("2026-11-14", "overdue", "sent")],
      [],
      ["three_days", "one_day", "due_day"],
    ],
  ])("%s", (_name, due, log, sends, skips) => {
    const result = plan({ tasks: [task(due)], log });

    expect(kindsSent(result)).toEqual(sends);
    expect(kindsSkipped(result)).toEqual(skips);
  });
});

describe("duplicates", () => {
  const DUE_WHEN_MOST_URGENT: Record<ReminderKind, string> = {
    three_days: "2026-11-18",
    one_day: "2026-11-16",
    due_day: "2026-11-15",
    overdue: "2026-11-14",
  };

  it.each(REMINDER_KINDS)(
    "plans nothing the second time for %s, however old the row",
    (kind) => {
      const due = DUE_WHEN_MOST_URGENT[kind];
      const first = plan({ tasks: [task(due)] });
      const old = ageAgo(STALE_CLAIM_MS * 1000);
      const log = [
        ...kindsSent(first).map((sent) => row(due, sent, "sent", old)),
        ...kindsSkipped(first).map((skipped) =>
          row(due, skipped, "skipped", old),
        ),
      ];

      expect(kindsSent(first)).toEqual([kind]);
      expect(plan({ tasks: [task(due)], log })).toEqual(NOTHING);
    },
  );
});

describe("claims", () => {
  it("retries a claim only once it is stale, after STALE_CLAIM_MS", () => {
    const sentWith = (claimedAt: Date) =>
      kindsSent(plan({ log: [row(TODAY, "due_day", "claimed", claimedAt)] }));

    expect(sentWith(ageAgo(60_000))).toEqual([]);
    expect(sentWith(ageAgo(STALE_CLAIM_MS))).toEqual([]);
    expect(sentWith(ageAgo(-STALE_CLAIM_MS * 2))).toEqual([]);
    expect(sentWith(ageAgo(STALE_CLAIM_MS + 1))).toEqual(["due_day"]);
    expect(sentWith(new Date(Number.NaN))).toEqual(["due_day"]);
  });

  it("skips a stale claim on a kind that has been overtaken", () => {
    const result = plan({
      tasks: [task("2026-11-16")],
      log: [
        row("2026-11-16", "three_days", "claimed", ageAgo(STALE_CLAIM_MS + 1)),
      ],
    });

    expect(kindsSent(result)).toEqual(["one_day"]);
    expect(kindsSkipped(result)).toEqual(["three_days"]);
  });
});

describe("malformed dates", () => {
  it.each<[string, unknown]>([
    ["an impossible date", "2026-02-30"],
    ["a null", null],
  ])("reports a task whose due date is %s and plans the others", (_n, bad) => {
    const badTask = { ...task(TODAY, { id: "bad" }), dueDate: bad as DateOnly };
    const result = plan({ tasks: [badTask, task(TODAY, { id: "good" })] });

    expect(result.invalidTaskIds).toEqual(["bad"]);
    expect(plain(result.events[0]?.reminders)).toEqual([
      { taskId: "good", dueDate: TODAY, kind: "due_day" },
    ]);
  });

  it.each<[string, Partial<PlanInput>]>([
    ["a malformed today", { today: "garbage" as DateOnly }],
    ["an invalid now", { now: new Date(Number.NaN) }],
  ])("throws a RangeError for %s, which affects every task", (_name, input) => {
    expect(() => plan(input)).toThrow(RangeError);
  });
});

describe("conditions that plan nothing", () => {
  const blockers: [string, Partial<PlanInput>, Partial<PlanTask>][] = [
    ["reminders are off", { remindersEnabled: false }, {}],
    ["the task is done", {}, { status: "done" }],
    ["the task is deleted", {}, { deleted: true }],
    ["the event is closed", { events: [event({ status: "closed" })] }, {}],
    [
      "the event's thread is not created yet",
      { events: [event({ threadStatus: "pending", threadId: null })] },
      {},
    ],
    [
      "the event's thread is missing",
      { events: [event({ threadStatus: "missing" })] },
      {},
    ],
    [
      "the forum is not managed",
      { events: [event({ forumManaged: false })] },
      {},
    ],
    ["the task's event is not in the input", { events: [] }, {}],
  ];

  it.each(blockers)("when %s", (_name, overrides, taskOverrides) => {
    const result = plan({
      tasks: [task("2026-11-14", taskOverrides)],
      log: [
        row("2026-11-14", "overdue", "claimed", ageAgo(STALE_CLAIM_MS + 1)),
      ],
      ...overrides,
    });
    expect(plain({ ...result, missingThreadEventIds: [] })).toEqual(NOTHING);
  });

  it("names an event whose post is gone once a reminder is due", () => {
    const missing = { events: [event({ threadStatus: "missing" })] };
    expect(
      plan({
        tasks: [task(TODAY, { id: "first" }), task(TODAY, { id: "second" })],
        ...missing,
      }).missingThreadEventIds,
    ).toEqual([EVENT_ID]);
    expect(
      plan({ tasks: [task("2030-01-01")], ...missing }).missingThreadEventIds,
    ).toEqual([]);
  });
});

describe("DST changes in New York", () => {
  // A 14:00 UTC cron is 09:00 EST and 10:00 EDT.
  function dailyAt1400(from: string, days: number): string[] {
    const start = Date.parse(`${from}T14:00:00Z`);
    return Array.from({ length: days }, (_unused, index) =>
      new Date(start + index * 86_400_000).toISOString(),
    );
  }

  it.each([
    ["spring-forward", "2026-03-08", "2026-03-04"],
    ["fall-back", "2026-11-01", "2026-10-28"],
  ])(
    "keeps one reminder per day when the deadline is the %s day",
    (_name, due, from) => {
      expect(
        simulate(due, dailyAt1400(from, 7)).map(({ sent }) => sent),
      ).toEqual([
        [],
        ["three_days"],
        [],
        ["one_day"],
        ["due_day"],
        ["overdue"],
        [],
      ]);
    },
  );

  it("sends once for runs in both copies of the repeated 1 AM hour", () => {
    expect(
      simulate("2026-11-01", [
        "2026-11-01T05:30:00Z",
        "2026-11-01T06:30:00Z",
        "2026-11-01T07:00:00Z",
      ]).map(({ sent }) => sent),
    ).toEqual([["due_day"], [], []]);
  });

  it("catches up when a fixed UTC cron never lands on the short day", () => {
    // 04:30 UTC is 23:30 EST on Mar 7, then 00:30 EDT on Mar 9, so Mar 8 has no run.
    expect(
      simulate("2026-03-08", ["2026-03-08T04:30:00Z", "2026-03-09T04:30:00Z"]),
    ).toEqual([
      { today: "2026-03-07", sent: ["one_day"], skipped: ["three_days"] },
      { today: "2026-03-09", sent: ["overdue"], skipped: ["due_day"] },
    ]);
  });

  it("does not repeat when a fixed UTC cron lands twice on the long day", () => {
    // 04:30 UTC is 00:30 EDT on Nov 1, then 23:30 EST on Nov 1.
    expect(
      simulate("2026-11-01", ["2026-11-01T04:30:00Z", "2026-11-02T04:30:00Z"]),
    ).toEqual([
      {
        today: "2026-11-01",
        sent: ["due_day"],
        skipped: ["three_days", "one_day"],
      },
      { today: "2026-11-01", sent: [], skipped: [] },
    ]);
  });
});

describe("slotToday", () => {
  it.each([
    // Midnight in Singapore falls between the crons: 23:00 and then 01:00 there.
    ["Asia/Singapore", "2026-11-10T15:00:00Z", "2026-11-10"],
    ["Asia/Singapore", "2026-11-10T17:00:00Z", "2026-11-10"],
    ["Asia/Singapore", "2026-11-11T02:00:00Z", "2026-11-10"],
    // New York on both clock-change days, at 10:00 or 11:00 there.
    ["America/New_York", "2026-03-08T15:00:00Z", "2026-03-08"],
    ["America/New_York", "2026-11-01T17:00:00Z", "2026-11-01"],
    // In the repeated hour, before the day's slot begins.
    ["America/New_York", "2026-11-01T06:30:00Z", "2026-10-31"],
    ["Pacific/Auckland", "2026-11-04T17:00:00Z", "2026-11-05"],
  ])("in %s at %s plans for %s", (zone, instant, expected) => {
    expect<string>(slotToday(new Date(instant), zone)).toBe(expected);
  });

  it("starts each slot at the first cron's hour", () => {
    const start = Date.UTC(2026, 10, 10, SLOT_START_HOUR_UTC);
    expect(slotStart(new Date(start))).toBe(start);
    expect(slotStart(new Date(start - 1_000))).toBe(start - 86_400_000);
    expect(dayRunStart(new Date(start - 1_000))).toBe(start);
  });
});

// The event step and Food pickup reminders.
const DAY = date(TODAY);
const ALICE = fakeId(10);
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
    thread_id: THREAD_ID,
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

describe("kindsDueToday", () => {
  it.each<[string, EventReminderKind[]]>([
    ["2026-11-14", []],
    ["2026-11-15", ["pickup_day"]],
    ["2026-11-16", []],
    ["2026-11-17", ["pickup_before"]],
    ["2026-11-18", []],
  ])("for a ready event on %s gives %j", (eventDate, kinds) => {
    expect(kindsDueToday(pickupReady(eventDate), DAY)).toEqual(kinds);
  });

  it("gives the step list while a step is open, up to the event's day", () => {
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-15") }), DAY),
    ).toEqual(["daily_steps"]);
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-14") }), DAY),
    ).toEqual([]);
    expect(
      kindsDueToday(
        candidate({ event_date: date("2026-11-15") }, ONLY_PICKUP_OPEN),
        DAY,
      ),
    ).toEqual([]);
  });

  it("gives no pickup reminder until Food pickup is set up", () => {
    expect(
      kindsDueToday(candidate({ event_date: date("2026-11-17") }), DAY),
    ).toEqual(["daily_steps"]);
  });
});

describe("planEventReminders", () => {
  const planEvents = (events: EventReminderCandidate[]) =>
    planEventReminders({ today: DAY, now: NOW, events });

  it("sends today's reminders to the event's thread", () => {
    expect(planEvents([candidate()])).toEqual({
      sends: [
        {
          ref: { eventId: EVENT_ID, kind: "daily_steps", reminderDate: DAY },
          threadId: THREAD_ID,
        },
      ],
      skips: [],
      freshClaims: [],
      missingThreadEventIds: [],
    });
  });

  it("names an event whose post is gone only if something is due, and sends to no pending post", () => {
    expect(
      planEvents([candidate({ thread_status: "missing", thread_id: null })])
        .missingThreadEventIds,
    ).toEqual([EVENT_ID]);
    expect(
      planEvents([candidate({ thread_status: "missing" }, ALL_DONE)])
        .missingThreadEventIds,
    ).toEqual([]);
    const pending = planEvents([
      candidate({ thread_status: "pending", thread_id: null }),
    ]);
    expect(pending.sends).toEqual([]);
    expect(pending.missingThreadEventIds).toEqual([]);
  });
});
