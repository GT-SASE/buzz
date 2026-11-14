import { describe, expect, it } from "bun:test";
import { fakeId } from "../../test/support/ids.ts";
import { channelMessage } from "../discord/outbound.ts";
import { safe, safeTextValue } from "../discord/safe-text.ts";
import type {
  EventStep,
  EventStepKind,
  EventWorkflow,
  StepAssignee,
} from "../db/types.ts";
import { EVENT_STEP_KINDS } from "../db/types.ts";
import type { DateOnly } from "../lib/dates.ts";
import {
  checklistLines,
  pickupTimeText,
  stepButtonRows,
  stepLine,
} from "./steps.ts";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVER = fakeId();
const NEW_YORK = "America/New_York";
const EVENT_DATE = "2026-11-03" as DateOnly;

/** The short-time Discord timestamp for an instant. */
const at = (iso: string) => `<t:${String(Date.parse(iso) / 1000)}:t>`;

function workflow(
  done: readonly EventStepKind[] = [],
  assignees: readonly Pick<StepAssignee, "kind" | "user_id">[] = [],
  pickupTime: string | null = null,
): EventWorkflow {
  return {
    event_id: EVENT_ID,
    event_date: EVENT_DATE,
    pickup_time: pickupTime,
    timezone: NEW_YORK,
    steps: EVENT_STEP_KINDS.map((kind): EventStep => ({
      event_id: EVENT_ID,
      kind,
      status: done.includes(kind) ? "done" : "open",
      completed_at: done.includes(kind) ? "2026-01-01T00:00:00Z" : null,
      completed_by: done.includes(kind) ? APPROVER : null,
      handoff_claimed_at: null,
      handoff_sent_at: null,
    })),
    assignees: assignees.map((assignee, index) => ({
      id: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
      event_id: EVENT_ID,
      assigned_by: APPROVER,
      created_at: "2026-01-01T00:00:00Z",
      ...assignee,
    })),
  };
}

const text = (value: Parameters<typeof safeTextValue>[0]) =>
  safeTextValue(value);

describe("pickupTimeText", () => {
  it.each([
    // After the fall change on 2026-11-01, and after the spring one on 2026-03-08.
    ["2026-11-03", "17:30", "2026-11-03T22:30:00Z"],
    ["2026-03-10", "17:30", "2026-03-10T21:30:00Z"],
    // Before each change.
    ["2026-10-31", "17:30", "2026-10-31T21:30:00Z"],
    ["2026-03-07", "17:30", "2026-03-07T22:30:00Z"],
  ])("shows %s %s in New York as the instant %s", (day, time, instant) => {
    expect(text(pickupTimeText(day as DateOnly, time, NEW_YORK))).toBe(
      at(instant),
    );
  });

  it("uses the guild's own zone", () => {
    expect(text(pickupTimeText(EVENT_DATE, "07:00", "Asia/Singapore"))).toBe(
      at("2026-11-02T23:00:00Z"),
    );
  });

  it("shows a plain 12-hour time without a zone it knows", () => {
    expect(text(pickupTimeText(EVENT_DATE, "17:30", "Mars/Base"))).toBe(
      String.raw`5\:30 PM`,
    );
  });
});

describe("the checklist", () => {
  it("has one line per step, with owners as mentions", () => {
    const first = fakeId();
    const second = fakeId();
    const picker = fakeId();
    const lines = checklistLines(
      workflow(
        ["budget_sheet", "budget_approved"],
        [
          { kind: "budget_sheet", user_id: first },
          { kind: "budget_sheet", user_id: second },
          { kind: "food_pickup", user_id: picker },
        ],
        "17:30",
      ),
    ).map(text);

    expect(lines).toEqual([
      "**Checklist**",
      `✅ Budget Sheet: <@${first}>, <@${second}>`,
      "⬜ Engage post: nobody assigned",
      `✅ Budget approved by <@${APPROVER}>`,
      `⬜ Food pickup: at ${at("2026-11-03T22:30:00Z")}, <@${picker}>`,
    ]);
    expect(text(stepLine(workflow(), "food_pickup"))).toBe(
      "⬜ Food pickup: time not set, nobody assigned",
    );
  });
});

describe("the step buttons", () => {
  function ids(flow: EventWorkflow): string[] {
    const body = channelMessage({
      content: safe`x`,
      mentionUserIds: [],
      components: stepButtonRows(flow),
    }).payload as { components: { components: { custom_id: string }[] }[] };
    return body.components.flatMap((row) =>
      row.components.map((part) => part.custom_id),
    );
  }

  it("offers a button for each open step but Food pickup, and none once done", () => {
    expect(ids(workflow())).toEqual([
      `event.sheet-done:${EVENT_ID}`,
      `event.engage-done:${EVENT_ID}`,
      `event.budget-ok:${EVENT_ID}`,
    ]);
    expect(ids(workflow(["engage_post"]))).toEqual([
      `event.sheet-done:${EVENT_ID}`,
      `event.budget-ok:${EVENT_ID}`,
    ]);
    expect(
      stepButtonRows(
        workflow(["budget_sheet", "engage_post", "budget_approved"]),
      ),
    ).toEqual([]);
  });
});
