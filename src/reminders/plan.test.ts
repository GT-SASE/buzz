import { describe, expect, it } from "vitest";
import { parseIsoDate, todayInZone, type DateOnly } from "../lib/dates.ts";
import {
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
 * Runs the planner at each instant with the due date the task has by then,
 * feeding what it decided back in as log rows the way the runner will, so a test
 * can watch a task's whole life.
 */
function simulateSchedule(
  steps: readonly (readonly [instant: string, due: string])[],
): DayResult[] {
  const log: ReminderLogRow[] = [];
  return steps.map(([instant, due]) => {
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

function simulate(due: string, instants: readonly string[]): DayResult[] {
  return simulateSchedule(instants.map((instant) => [instant, due]));
}

function simulateDays(due: string, todays: readonly string[]) {
  return simulate(
    due,
    todays.map((today) => `${today}T15:00:00Z`),
  );
}

describe("reminder windows", () => {
  it.each<[string, string, ReminderKind | null, ReminderKind[]]>([
    ["more than a week before", "2026-11-30", null, []],
    ["4 days before", "2026-11-19", null, []],
    ["3 days before", "2026-11-18", "three_days", []],
    ["2 days before, after a missed run", "2026-11-17", "three_days", []],
    ["1 day before", "2026-11-16", "one_day", ["three_days"]],
    ["the due day", "2026-11-15", "due_day", ["three_days", "one_day"]],
    [
      "1 day overdue",
      "2026-11-14",
      "overdue",
      ["three_days", "one_day", "due_day"],
    ],
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

  it("sends each kind on its own day when every run happens", () => {
    expect(
      simulateDays("2026-11-15", [
        "2026-11-11",
        "2026-11-12",
        "2026-11-13",
        "2026-11-14",
        "2026-11-15",
        "2026-11-16",
        "2026-11-17",
      ]),
    ).toEqual([
      { today: "2026-11-11", sent: [], skipped: [] },
      { today: "2026-11-12", sent: ["three_days"], skipped: [] },
      { today: "2026-11-13", sent: [], skipped: [] },
      { today: "2026-11-14", sent: ["one_day"], skipped: [] },
      { today: "2026-11-15", sent: ["due_day"], skipped: [] },
      { today: "2026-11-16", sent: ["overdue"], skipped: [] },
      { today: "2026-11-17", sent: [], skipped: [] },
    ]);
  });
});

describe("catch-up after a missed run", () => {
  it.each<[string, string, ReminderLogRow[], ReminderKind[], ReminderKind[]]>([
    [
      "three_days missed, now 1 day before",
      "2026-11-16",
      [],
      ["one_day"],
      ["three_days"],
    ],
    [
      "one_day missed, now the due day",
      "2026-11-15",
      [row("2026-11-15", "three_days", "sent")],
      ["due_day"],
      ["one_day"],
    ],
    [
      "due_day missed, now overdue",
      "2026-11-14",
      [
        row("2026-11-14", "three_days", "sent"),
        row("2026-11-14", "one_day", "sent"),
      ],
      ["overdue"],
      ["due_day"],
    ],
    [
      "one_day and due_day missed, now overdue",
      "2026-11-10",
      [row("2026-11-10", "three_days", "sent")],
      ["overdue"],
      ["one_day", "due_day"],
    ],
    [
      "earlier kinds already skipped are not skipped again",
      "2026-11-14",
      [
        row("2026-11-14", "three_days", "skipped"),
        row("2026-11-14", "one_day", "sent"),
      ],
      ["overdue"],
      ["due_day"],
    ],
    [
      "a hole below a sent kind is filled in without sending it",
      "2026-11-14",
      [row("2026-11-14", "overdue", "sent")],
      [],
      ["three_days", "one_day", "due_day"],
    ],
    [
      "a hole below a skipped kind is filled in without sending it",
      "2026-11-15",
      [row("2026-11-15", "due_day", "skipped")],
      [],
      ["three_days", "one_day"],
    ],
  ])("%s", (_name, due, log, sends, skips) => {
    const result = plan({ tasks: [task(due)], log });

    expect(kindsSent(result)).toEqual(sends);
    expect(kindsSkipped(result)).toEqual(skips);
  });

  it("does not mark future kinds as skipped", () => {
    const result = plan({ tasks: [task("2026-11-18")] });

    expect(kindsSkipped(result)).toEqual([]);
  });

  it("sends the rest on schedule after a gap", () => {
    expect(
      simulateDays("2026-11-15", ["2026-11-14", "2026-11-15", "2026-11-16"]),
    ).toEqual([
      { today: "2026-11-14", sent: ["one_day"], skipped: ["three_days"] },
      { today: "2026-11-15", sent: ["due_day"], skipped: [] },
      { today: "2026-11-16", sent: ["overdue"], skipped: [] },
    ]);
  });

  it("does one overdue reminder when every earlier run was missed", () => {
    expect(simulateDays("2026-11-15", ["2026-11-20", "2026-11-21"])).toEqual([
      {
        today: "2026-11-20",
        sent: ["overdue"],
        skipped: ["three_days", "one_day", "due_day"],
      },
      { today: "2026-11-21", sent: [], skipped: [] },
    ]);
  });
});

describe("duplicates", () => {
  const DUE_WHEN_MOST_URGENT: Record<ReminderKind, string> = {
    three_days: "2026-11-18",
    one_day: "2026-11-16",
    due_day: "2026-11-15",
    overdue: "2026-11-14",
  };

  describe.each(REMINDER_KINDS)("for %s", (kind) => {
    it.each<ReminderState>(["sent", "skipped"])(
      "never repeats a %s row, however old",
      (state) => {
        const result = plan({
          tasks: [task(DUE_WHEN_MOST_URGENT[kind])],
          log: [
            row(
              DUE_WHEN_MOST_URGENT[kind],
              kind,
              state,
              ageAgo(STALE_CLAIM_MS * 1000),
            ),
          ],
        });

        expect(kindsSent(result)).toEqual([]);
      },
    );

    it("plans nothing the second time once its plan is applied", () => {
      const due = DUE_WHEN_MOST_URGENT[kind];
      const first = plan({ tasks: [task(due)] });
      const log = [
        ...kindsSent(first).map((sent) => row(due, sent, "sent", NOW)),
        ...kindsSkipped(first).map((skipped) =>
          row(due, skipped, "skipped", NOW),
        ),
      ];

      expect(kindsSent(first)).toEqual([kind]);
      expect(plan({ tasks: [task(due)], log })).toEqual(NOTHING);
    });
  });

  it("keeps log rows of one task away from another", () => {
    const result = plan({
      tasks: [task(TODAY, { id: "task-2" })],
      log: [row(TODAY, "due_day", "sent")],
    });

    expect(result.events[0]?.reminders).toEqual([
      { taskId: "task-2", dueDate: TODAY, kind: "due_day" },
    ]);
  });

  it("ignores log rows for tasks that are not in the input", () => {
    const result = plan({
      tasks: [],
      log: [
        row(TODAY, "due_day", "claimed", ageAgo(STALE_CLAIM_MS * 2), "gone"),
      ],
    });

    expect(result).toEqual(NOTHING);
  });
});

describe("claims", () => {
  it("leaves a fresh claim alone", () => {
    const result = plan({
      log: [row(TODAY, "due_day", "claimed", ageAgo(60_000))],
    });

    expect(kindsSent(result)).toEqual([]);
  });

  it("treats a claim of exactly one hour as fresh", () => {
    const result = plan({
      log: [row(TODAY, "due_day", "claimed", ageAgo(STALE_CLAIM_MS))],
    });

    expect(kindsSent(result)).toEqual([]);
  });

  it("retries a claim just over one hour old", () => {
    const result = plan({
      log: [row(TODAY, "due_day", "claimed", ageAgo(STALE_CLAIM_MS + 1))],
    });

    expect(kindsSent(result)).toEqual(["due_day"]);
  });

  it("treats a claim dated in the future as fresh", () => {
    const result = plan({
      log: [row(TODAY, "due_day", "claimed", ageAgo(-STALE_CLAIM_MS * 2))],
    });

    expect(kindsSent(result)).toEqual([]);
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

  it("does not touch a fresh claim on a kind that has been overtaken", () => {
    const result = plan({
      tasks: [task("2026-11-16")],
      log: [row("2026-11-16", "three_days", "claimed", ageAgo(60_000))],
    });

    expect(kindsSent(result)).toEqual(["one_day"]);
    expect(kindsSkipped(result)).toEqual([]);
  });

  it("still skips open earlier kinds while the most urgent is claimed", () => {
    const result = plan({
      log: [
        row(TODAY, "due_day", "claimed", ageAgo(60_000)),
        row(TODAY, "one_day", "claimed", ageAgo(STALE_CLAIM_MS + 1)),
      ],
    });

    expect(kindsSent(result)).toEqual([]);
    expect(kindsSkipped(result)).toEqual(["three_days", "one_day"]);
  });

  it("does not retry a stale claim below a kind already sent", () => {
    const result = plan({
      log: [
        row(TODAY, "due_day", "sent"),
        row(TODAY, "one_day", "claimed", ageAgo(STALE_CLAIM_MS + 1)),
      ],
    });

    expect(kindsSent(result)).toEqual([]);
    expect(kindsSkipped(result)).toEqual(["three_days", "one_day"]);
  });

  it("measures claim age from now, not from today", () => {
    const claimedAt = new Date("2026-11-15T13:30:00Z");
    const log = [row(TODAY, "due_day", "claimed", claimedAt)];
    const after = (ms: number) => new Date(claimedAt.getTime() + ms);

    expect(kindsSent(plan({ now: after(STALE_CLAIM_MS), log }))).toEqual([]);
    expect(
      kindsSent(plan({ now: after(STALE_CLAIM_MS + 1_000), log })),
    ).toEqual(["due_day"]);
  });
});

describe("unreadable claim times", () => {
  const unreadable: [string, unknown][] = [
    ["an invalid Date", new Date(Number.NaN)],
    ["a string that is not a date", "not a date"],
    ["a missing value", undefined],
  ];

  describe.each(unreadable)("with %s", (_name, claimedAt) => {
    const claim = (due: string, kind: ReminderKind): ReminderLogRow => ({
      ...row(due, kind, "claimed"),
      claimedAt: claimedAt as Date,
    });

    it("counts as stale so the most urgent kind is retried", () => {
      const result = plan({ log: [claim(TODAY, "due_day")] });

      expect(kindsSent(result)).toEqual(["due_day"]);
    });

    it("counts as stale so an overtaken kind is skipped", () => {
      const result = plan({
        tasks: [task("2026-11-16")],
        log: [claim("2026-11-16", "three_days")],
      });

      expect(kindsSent(result)).toEqual(["one_day"]);
      expect(kindsSkipped(result)).toEqual(["three_days"]);
    });
  });

  it("reads a date string that got past the types", () => {
    const claimed = (at: string): ReminderLogRow => ({
      ...row(TODAY, "due_day", "claimed"),
      claimedAt: at as unknown as Date,
    });

    const at = (date: Date) => date.toISOString();
    expect(
      kindsSent(plan({ log: [claimed(at(ageAgo(STALE_CLAIM_MS)))] })),
    ).toEqual([]);
    expect(
      kindsSent(plan({ log: [claimed(at(ageAgo(STALE_CLAIM_MS + 1_000)))] })),
    ).toEqual(["due_day"]);
  });

  it("does not affect a sent or skipped row", () => {
    const invalid = new Date(Number.NaN);

    expect(
      plan({
        log: [
          row(TODAY, "three_days", "skipped", invalid),
          row(TODAY, "one_day", "sent", invalid),
          row(TODAY, "due_day", "sent", invalid),
        ],
      }),
    ).toEqual(NOTHING);
  });
});

describe("malformed dates", () => {
  describe.each<[string, unknown]>([
    ["an impossible date", "2026-02-30"],
    ["a timestamp", "2026-11-15T00:00:00Z"],
    ["text", "garbage"],
    ["an empty string", ""],
    ["a null", null],
  ])("when a due date is %s", (_name, bad) => {
    const badTask = {
      ...task(TODAY, { id: "bad" }),
      dueDate: bad as DateOnly,
    };

    it("reports that task and still plans the others", () => {
      const result = plan({ tasks: [badTask, task(TODAY, { id: "good" })] });

      expect(result.invalidTaskIds).toEqual(["bad"]);
      expect(result.events[0]?.reminders).toEqual([
        { taskId: "good", dueDate: TODAY, kind: "due_day" },
      ]);
      expect(result.skips.map((skip) => skip.taskId)).toEqual(["good", "good"]);
    });

    it("does not report a task that would not be reminded about anyway", () => {
      const result = plan({ tasks: [{ ...badTask, status: "done" }] });

      expect(result).toEqual(NOTHING);
    });
  });

  it("ignores a log row with a malformed due date", () => {
    const result = plan({
      log: [
        {
          ...row(TODAY, "due_day", "sent"),
          dueDate: "garbage" as DateOnly,
        },
      ],
    });

    expect(kindsSent(result)).toEqual(["due_day"]);
  });

  it.each<[string, Partial<PlanInput>]>([
    ["a malformed today", { today: "garbage" as DateOnly }],
    ["an impossible today", { today: "2026-02-30" as DateOnly }],
    ["an invalid now", { now: new Date(Number.NaN) }],
  ])("throws a RangeError for %s, which affects every task", (_name, input) => {
    expect(() => plan(input)).toThrow(RangeError);
  });
});

describe("moving a due date", () => {
  const FIRST = "2026-11-15";
  const LATER = "2026-11-25";
  const day = (today: string, due: string) =>
    [`${today}T15:00:00Z`, due] as const;

  it("is quiet until the new window, then sends again after all were sent", () => {
    expect(
      simulateSchedule([
        day("2026-11-12", FIRST),
        day("2026-11-14", FIRST),
        day("2026-11-15", FIRST),
        day("2026-11-16", FIRST),
        day("2026-11-17", LATER),
        day("2026-11-21", LATER),
        day("2026-11-22", LATER),
        day("2026-11-24", LATER),
        day("2026-11-25", LATER),
        day("2026-11-26", LATER),
        day("2026-11-27", LATER),
      ]).map(({ today, sent }) => [today, sent]),
    ).toEqual([
      ["2026-11-12", ["three_days"]],
      ["2026-11-14", ["one_day"]],
      ["2026-11-15", ["due_day"]],
      ["2026-11-16", ["overdue"]],
      ["2026-11-17", []],
      ["2026-11-21", []],
      ["2026-11-22", ["three_days"]],
      ["2026-11-24", ["one_day"]],
      ["2026-11-25", ["due_day"]],
      ["2026-11-26", ["overdue"]],
      ["2026-11-27", []],
    ]);
  });

  it("never repeats on the same date", () => {
    const log = REMINDER_KINDS.map((kind) => row(FIRST, kind, "sent"));

    expect(
      plan({ today: date("2026-11-30"), tasks: [task(FIRST)], log }),
    ).toEqual(NOTHING);
  });

  it("respects the first date's history when moved away and back", () => {
    expect(
      simulateSchedule([
        day("2026-11-12", FIRST),
        day("2026-11-13", LATER),
        day("2026-11-13", FIRST),
        day("2026-11-14", FIRST),
        day("2026-11-14", LATER),
        day("2026-11-14", FIRST),
      ]),
    ).toEqual([
      { today: "2026-11-12", sent: ["three_days"], skipped: [] },
      { today: "2026-11-13", sent: [], skipped: [] },
      { today: "2026-11-13", sent: [], skipped: [] },
      { today: "2026-11-14", sent: ["one_day"], skipped: [] },
      { today: "2026-11-14", sent: [], skipped: [] },
      { today: "2026-11-14", sent: [], skipped: [] },
    ]);
  });

  it("keeps each date's history separate when moved back after both ran", () => {
    expect(
      simulateSchedule([
        day("2026-11-22", LATER),
        day("2026-11-23", "2026-11-26"),
        day("2026-11-23", LATER),
      ]).map(({ sent }) => sent),
    ).toEqual([["three_days"], ["three_days"], []]);
  });

  it.each<[string, Date]>([
    ["stale", ageAgo(STALE_CLAIM_MS + 1)],
    ["fresh", ageAgo(60_000)],
  ])("is not blocked by a %s claim on the old date", (_name, claimedAt) => {
    const result = plan({
      tasks: [task(TODAY)],
      log: [row("2026-11-10", "due_day", "claimed", claimedAt)],
    });

    expect(result).toEqual({
      events: [
        {
          eventId: EVENT_ID,
          threadId: THREAD_ID,
          reminders: [{ taskId: TASK_ID, dueDate: TODAY, kind: "due_day" }],
        },
      ],
      skips: [
        { taskId: TASK_ID, dueDate: TODAY, kind: "three_days" },
        { taskId: TASK_ID, dueDate: TODAY, kind: "one_day" },
      ],
      freshClaims: [],
      missingThreadEventIds: [],
      invalidTaskIds: [],
    });
  });

  it.each<[string, ReminderKind, ReminderKind[]]>([
    ["2026-11-17", "three_days", []],
    ["2026-11-16", "one_day", ["three_days"]],
    ["2026-11-15", "due_day", ["three_days", "one_day"]],
    ["2026-11-14", "overdue", ["three_days", "one_day", "due_day"]],
  ])("uses normal catch-up when moved earlier to %s", (due, sends, skips) => {
    const result = plan({
      tasks: [task(due)],
      log: [row("2026-11-30", "three_days", "sent")],
    });

    expect(kindsSent(result)).toEqual([sends]);
    expect(kindsSkipped(result)).toEqual(skips);
    expect(result.skips.every((skip) => skip.dueDate === due)).toBe(true);
  });
});

describe("conditions that plan nothing", () => {
  const blockers: [string, Partial<PlanInput>, Partial<PlanTask>][] = [
    ["reminders are off", { remindersEnabled: false }, {}],
    ["the task is done", {}, { status: "done" }],
    ["the task is deleted", {}, { deleted: true }],
    ["the event is closed", { events: [event({ status: "closed" })] }, {}],
    ["the event is deleted", { events: [event({ deleted: true })] }, {}],
    [
      "the event's thread is not created yet",
      { events: [event({ threadStatus: "pending", threadId: null })] },
      {},
    ],
    [
      "the event's thread is pending but has an ID",
      { events: [event({ threadStatus: "pending" })] },
      {},
    ],
    [
      "the event's thread is missing",
      { events: [event({ threadStatus: "missing" })] },
      {},
    ],
    [
      "the event has no thread ID",
      { events: [event({ threadStatus: "active", threadId: null })] },
      {},
    ],
    [
      "the forum is not managed",
      { events: [event({ forumManaged: false })] },
      {},
    ],
    ["the task's event is not in the input", { events: [] }, {}],
  ];

  describe.each(blockers)("when %s", (_name, overrides, taskOverrides) => {
    it.each(["2026-11-18", "2026-11-16", "2026-11-15", "2026-11-14"])(
      "plans no sends or skips for a task due %s",
      (due) => {
        const result = plan({
          tasks: [task(due, taskOverrides)],
          ...overrides,
        });
        expect({ ...result, missingThreadEventIds: [] }).toEqual(NOTHING);
      },
    );

    it("leaves a stale claim as it is", () => {
      const result = plan({
        tasks: [task("2026-11-14", taskOverrides)],
        log: [
          row("2026-11-14", "overdue", "claimed", ageAgo(STALE_CLAIM_MS + 1)),
        ],
        ...overrides,
      });

      expect({ ...result, missingThreadEventIds: [] }).toEqual(NOTHING);
    });
  });

  describe("an event whose post is gone", () => {
    const missing = { events: [event({ threadStatus: "missing" })] };

    it("names the event once a reminder is due, however many tasks it holds", () => {
      const result = plan({
        tasks: [task(TODAY, { id: "first" }), task(TODAY, { id: "second" })],
        ...missing,
      });
      expect(result.missingThreadEventIds).toEqual([EVENT_ID]);
    });

    it("does not name it while nothing is due", () => {
      const result = plan({ tasks: [task("2030-01-01")], ...missing });
      expect(result.missingThreadEventIds).toEqual([]);
    });

    it("does not name an event that is merely waiting for its first post", () => {
      const result = plan({
        tasks: [task(TODAY)],
        events: [event({ threadStatus: "pending", threadId: null })],
      });
      expect(result.missingThreadEventIds).toEqual([]);
    });
  });

  describe("a claim too recent to take over", () => {
    it("reports the most urgent kind and does not send it", () => {
      const result = plan({
        tasks: [task(TODAY)],
        log: [row(TODAY, "due_day", "claimed", ageAgo(60_000))],
      });
      expect(result.events).toEqual([]);
      expect(result.freshClaims).toEqual([
        {
          eventId: EVENT_ID,
          ref: { taskId: TASK_ID, dueDate: TODAY, kind: "due_day" },
        },
      ]);
    });

    it("does not report an older kind, since a newer one goes out", () => {
      const result = plan({
        tasks: [task(TODAY)],
        log: [row(TODAY, "one_day", "claimed", ageAgo(60_000))],
      });
      expect(result.freshClaims).toEqual([]);
      expect(result.events).toHaveLength(1);
    });
  });

  it("only blocks the affected task", () => {
    const result = plan({
      tasks: [
        task(TODAY, { id: "done", status: "done" }),
        task(TODAY, { id: "deleted", deleted: true }),
        task(TODAY, { id: "open" }),
      ],
    });

    expect(result.events).toEqual([
      {
        eventId: EVENT_ID,
        threadId: THREAD_ID,
        reminders: [{ taskId: "open", dueDate: TODAY, kind: "due_day" }],
      },
    ]);
  });

  it("only blocks the affected event", () => {
    const result = plan({
      events: [
        event({ id: "closed", status: "closed" }),
        event({ id: "unmanaged", forumManaged: false }),
        event({ id: "live", threadId: "live-thread" }),
      ],
      tasks: [
        task(TODAY, { id: "a", eventId: "closed" }),
        task(TODAY, { id: "b", eventId: "unmanaged" }),
        task(TODAY, { id: "c", eventId: "live" }),
      ],
    });

    expect(result.events).toEqual([
      {
        eventId: "live",
        threadId: "live-thread",
        reminders: [{ taskId: "c", dueDate: TODAY, kind: "due_day" }],
      },
    ]);
    expect(result.skips.map((skip) => skip.taskId)).toEqual(["c", "c"]);
  });
});

describe("removing and re-adding a forum", () => {
  function runDay(
    today: string,
    forumManaged: boolean,
    log: readonly ReminderLogRow[],
  ): ReminderPlan {
    return plan({
      today: date(today),
      tasks: [task("2026-11-15")],
      events: [event({ forumManaged })],
      log,
    });
  }

  it("uses nothing up while removed, then resumes with catch-up", () => {
    const log = [row("2026-11-15", "three_days", "sent")];

    expect(runDay("2026-11-14", false, log)).toEqual(NOTHING);
    expect(runDay("2026-11-15", false, log)).toEqual(NOTHING);

    const resumed = runDay("2026-11-15", true, log);
    expect(kindsSent(resumed)).toEqual(["due_day"]);
    expect(kindsSkipped(resumed)).toEqual(["one_day"]);
  });

  it("resumes on the most urgent kind when re-added after the deadline", () => {
    const resumed = runDay("2026-12-01", true, [
      row("2026-11-15", "three_days", "sent"),
    ]);

    expect(kindsSent(resumed)).toEqual(["overdue"]);
    expect(kindsSkipped(resumed)).toEqual(["one_day", "due_day"]);
  });

  it("does not repeat a kind sent before the removal", () => {
    const resumed = runDay("2026-11-15", true, [
      row("2026-11-15", "three_days", "sent"),
      row("2026-11-15", "one_day", "sent"),
      row("2026-11-15", "due_day", "sent"),
    ]);

    expect(resumed).toEqual(NOTHING);
  });
});

describe("turning reminders off and on", () => {
  it("catches up under the same rules once back on", () => {
    const tasks = [task("2026-11-15")];

    expect(plan({ remindersEnabled: false, tasks })).toEqual(NOTHING);

    const resumed = plan({ remindersEnabled: true, tasks });
    expect(kindsSent(resumed)).toEqual(["due_day"]);
    expect(kindsSkipped(resumed)).toEqual(["three_days", "one_day"]);
  });
});

describe("the shape of the plan", () => {
  it("groups reminders per event with each event's thread", () => {
    const result = plan({
      events: [
        event({ id: "a", threadId: "thread-a" }),
        event({ id: "b", threadId: "thread-b" }),
      ],
      tasks: [
        task("2026-11-18", { id: "a1", eventId: "a" }),
        task("2026-11-18", { id: "b1", eventId: "b" }),
        task("2026-11-19", { id: "a-later", eventId: "a" }),
        task("2026-11-14", { id: "a2", eventId: "a" }),
      ],
    });

    expect(result.events).toEqual([
      {
        eventId: "a",
        threadId: "thread-a",
        reminders: [
          { taskId: "a1", dueDate: "2026-11-18", kind: "three_days" },
          { taskId: "a2", dueDate: "2026-11-14", kind: "overdue" },
        ],
      },
      {
        eventId: "b",
        threadId: "thread-b",
        reminders: [
          { taskId: "b1", dueDate: "2026-11-18", kind: "three_days" },
        ],
      },
    ]);
  });

  it("lists skips by task and kind", () => {
    const result = plan({
      tasks: [task("2026-11-16", { id: "a" }), task("2026-11-15", { id: "b" })],
    });

    expect(result.skips).toEqual([
      { taskId: "a", dueDate: "2026-11-16", kind: "three_days" },
      { taskId: "b", dueDate: "2026-11-15", kind: "three_days" },
      { taskId: "b", dueDate: "2026-11-15", kind: "one_day" },
    ]);
  });

  it("gives no group to an event whose only output is skips", () => {
    const result = plan({
      tasks: [task("2026-11-14")],
      log: [row("2026-11-14", "overdue", "sent")],
    });

    expect(result.events).toEqual([]);
    expect(kindsSkipped(result)).toEqual(["three_days", "one_day", "due_day"]);
  });

  it("plans nothing for no tasks", () => {
    expect(plan({ tasks: [] })).toEqual(NOTHING);
  });

  it("gives the same plan for the same input and leaves the input alone", () => {
    const input: PlanInput = {
      today: date(TODAY),
      now: NOW,
      remindersEnabled: true,
      events: [event()],
      tasks: [task("2026-11-14")],
      log: [row("2026-11-14", "three_days", "sent")],
    };
    const snapshot = structuredClone(input);

    expect(planReminders(input)).toEqual(planReminders(input));
    expect(input).toEqual(snapshot);
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

  it("keeps one reminder per day when the deadline is the spring-forward day", () => {
    expect(simulate("2026-03-08", dailyAt1400("2026-03-04", 7))).toEqual([
      { today: "2026-03-04", sent: [], skipped: [] },
      { today: "2026-03-05", sent: ["three_days"], skipped: [] },
      { today: "2026-03-06", sent: [], skipped: [] },
      { today: "2026-03-07", sent: ["one_day"], skipped: [] },
      { today: "2026-03-08", sent: ["due_day"], skipped: [] },
      { today: "2026-03-09", sent: ["overdue"], skipped: [] },
      { today: "2026-03-10", sent: [], skipped: [] },
    ]);
  });

  it("keeps one reminder per day when the deadline is the fall-back day", () => {
    expect(simulate("2026-11-01", dailyAt1400("2026-10-28", 7))).toEqual([
      { today: "2026-10-28", sent: [], skipped: [] },
      { today: "2026-10-29", sent: ["three_days"], skipped: [] },
      { today: "2026-10-30", sent: [], skipped: [] },
      { today: "2026-10-31", sent: ["one_day"], skipped: [] },
      { today: "2026-11-01", sent: ["due_day"], skipped: [] },
      { today: "2026-11-02", sent: ["overdue"], skipped: [] },
      { today: "2026-11-03", sent: [], skipped: [] },
    ]);
  });

  it("counts windows by date when a window spans each change", () => {
    expect(simulate("2026-03-09", ["2026-03-06T14:00:00Z"])).toEqual([
      { today: "2026-03-06", sent: ["three_days"], skipped: [] },
    ]);
    expect(simulate("2026-11-02", ["2026-10-30T14:00:00Z"])).toEqual([
      { today: "2026-10-30", sent: ["three_days"], skipped: [] },
    ]);
  });

  it("sends once for runs either side of the skipped 2 AM hour", () => {
    expect(
      simulate("2026-03-08", ["2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z"]),
    ).toEqual([
      {
        today: "2026-03-08",
        sent: ["due_day"],
        skipped: ["three_days", "one_day"],
      },
      { today: "2026-03-08", sent: [], skipped: [] },
    ]);
  });

  it("sends once for runs in both copies of the repeated 1 AM hour", () => {
    expect(
      simulate("2026-11-01", [
        "2026-11-01T05:30:00Z",
        "2026-11-01T06:30:00Z",
        "2026-11-01T07:00:00Z",
      ]),
    ).toEqual([
      {
        today: "2026-11-01",
        sent: ["due_day"],
        skipped: ["three_days", "one_day"],
      },
      { today: "2026-11-01", sent: [], skipped: [] },
      { today: "2026-11-01", sent: [], skipped: [] },
    ]);
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

describe("a UTC cron crossing midnight relative to New York", () => {
  const LATE_UTC = "2026-11-16T03:30:00Z"; // 22:30 EST on Nov 15.

  it.each<[string, ReminderKind]>([
    // The UTC date is Nov 16, which would give overdue, due_day and one_day here.
    ["2026-11-15", "due_day"],
    ["2026-11-16", "one_day"],
    ["2026-11-17", "three_days"],
    ["2026-11-14", "overdue"],
  ])("uses the New York date for a task due %s", (due, kind) => {
    const [day] = simulate(due, [LATE_UTC]);

    expect(day?.today).toBe("2026-11-15");
    expect(day?.sent).toEqual([kind]);
  });

  it("sends nothing yet for a task the UTC date alone would remind about", () => {
    const [day] = simulate("2026-11-19", [LATE_UTC]);

    expect(day?.sent).toEqual([]);
  });

  it("moves on once New York reaches the next day", () => {
    expect(
      simulate("2026-11-15", [LATE_UTC, "2026-11-16T05:00:00Z"]).map(
        (day) => day.sent,
      ),
    ).toEqual([["due_day"], ["overdue"]]);
  });
});

describe("year boundaries", () => {
  it("runs a deadline on New Year's Day through the old year", () => {
    expect(
      simulateDays("2027-01-01", [
        "2026-12-28",
        "2026-12-29",
        "2026-12-31",
        "2027-01-01",
        "2027-01-02",
      ]),
    ).toEqual([
      { today: "2026-12-28", sent: [], skipped: [] },
      { today: "2026-12-29", sent: ["three_days"], skipped: [] },
      { today: "2026-12-31", sent: ["one_day"], skipped: [] },
      { today: "2027-01-01", sent: ["due_day"], skipped: [] },
      { today: "2027-01-02", sent: ["overdue"], skipped: [] },
    ]);
  });

  it("marks a Dec 31 deadline overdue on Jan 1", () => {
    const result = plan({
      today: date("2027-01-01"),
      tasks: [task("2026-12-31")],
      log: [
        row("2026-12-31", "three_days", "sent"),
        row("2026-12-31", "one_day", "sent"),
        row("2026-12-31", "due_day", "sent"),
      ],
    });

    expect(kindsSent(result)).toEqual(["overdue"]);
  });

  it("uses the New York year when UTC has already reached the new one", () => {
    expect(simulate("2026-12-31", ["2027-01-01T04:30:00Z"])).toEqual([
      {
        today: "2026-12-31",
        sent: ["due_day"],
        skipped: ["three_days", "one_day"],
      },
    ]);
  });
});

describe("leap days", () => {
  it("runs a Feb 29 deadline through its windows", () => {
    expect(
      simulateDays("2028-02-29", [
        "2028-02-25",
        "2028-02-26",
        "2028-02-28",
        "2028-02-29",
        "2028-03-01",
      ]),
    ).toEqual([
      { today: "2028-02-25", sent: [], skipped: [] },
      { today: "2028-02-26", sent: ["three_days"], skipped: [] },
      { today: "2028-02-28", sent: ["one_day"], skipped: [] },
      { today: "2028-02-29", sent: ["due_day"], skipped: [] },
      { today: "2028-03-01", sent: ["overdue"], skipped: [] },
    ]);
  });

  it.each<[string, string, ReminderKind]>([
    // Mar 1 is 3 days after Feb 27 in a leap year, and after Feb 26 otherwise.
    ["2028-03-01", "2028-02-27", "three_days"],
    ["2027-03-01", "2027-02-26", "three_days"],
    // The day before Mar 1 is Feb 29 in a leap year and Feb 28 otherwise.
    ["2028-03-01", "2028-02-29", "one_day"],
    ["2027-03-01", "2027-02-28", "one_day"],
  ])("for a task due %s, on %s sends %s", (due, today, kind) => {
    const result = plan({ today: date(today), tasks: [task(due)] });

    expect(kindsSent(result)).toEqual([kind]);
  });

  it("does not open a window a day early because of the leap day", () => {
    const result = plan({
      today: date("2028-02-26"),
      tasks: [task("2028-03-01")],
    });

    expect(kindsSent(result)).toEqual([]);
  });
});

describe("slotToday", () => {
  it.each([
    // Midnight in Singapore falls between the crons: 23:00 and then 01:00 there.
    ["Asia/Singapore", "2026-11-10T15:00:00Z", "2026-11-10"],
    ["Asia/Singapore", "2026-11-10T17:00:00Z", "2026-11-10"],
    ["Asia/Singapore", "2026-11-11T02:00:00Z", "2026-11-10"],
    // New York either side of both clock changes, at 10:00 or 11:00 there.
    ["America/New_York", "2026-03-07T15:00:00Z", "2026-03-07"],
    ["America/New_York", "2026-03-07T17:00:00Z", "2026-03-07"],
    ["America/New_York", "2026-03-08T15:00:00Z", "2026-03-08"],
    ["America/New_York", "2026-03-08T17:00:00Z", "2026-03-08"],
    ["America/New_York", "2026-10-31T15:00:00Z", "2026-10-31"],
    ["America/New_York", "2026-10-31T17:00:00Z", "2026-10-31"],
    ["America/New_York", "2026-11-01T15:00:00Z", "2026-11-01"],
    ["America/New_York", "2026-11-01T17:00:00Z", "2026-11-01"],
    // In the repeated hour, before the day's slot begins.
    ["America/New_York", "2026-11-01T05:30:00Z", "2026-10-31"],
    ["America/New_York", "2026-11-01T06:30:00Z", "2026-10-31"],
    ["Pacific/Auckland", "2026-11-04T17:00:00Z", "2026-11-05"],
  ])("in %s at %s plans for %s", (zone, instant, expected) => {
    expect(slotToday(new Date(instant), zone)).toBe(expected);
  });

  it("gives both crons of a slot the same date where the plain date differs", () => {
    const morning = new Date("2026-11-10T15:00:00Z");
    const recovery = new Date("2026-11-10T17:00:00Z");
    expect(todayInZone(recovery, "Asia/Singapore")).not.toBe(
      todayInZone(morning, "Asia/Singapore"),
    );
    expect(slotToday(recovery, "Asia/Singapore")).toBe(
      slotToday(morning, "Asia/Singapore"),
    );
  });

  it("starts each slot at 15:00 UTC", () => {
    expect(slotStart(new Date("2026-11-10T15:00:00Z"))).toBe(
      Date.parse("2026-11-10T15:00:00Z"),
    );
    expect(slotStart(new Date("2026-11-10T14:59:59Z"))).toBe(
      Date.parse("2026-11-09T15:00:00Z"),
    );
  });
});
