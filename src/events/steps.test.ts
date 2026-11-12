import { describe, expect, it } from "vitest";
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
import {
  checklistLines,
  isStepDone,
  ownersText,
  pickupTimeText,
  stepButtonId,
  stepButtonRows,
  stepLine,
  stepOwnerIds,
} from "./steps.ts";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const APPROVER = fakeId();

function workflow(
  done: readonly EventStepKind[] = [],
  assignees: readonly Pick<StepAssignee, "kind" | "user_id">[] = [],
  pickupTime: string | null = null,
): EventWorkflow {
  return {
    event_id: EVENT_ID,
    pickup_time: pickupTime,
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
    ["00:05", String.raw`12\:05 AM`],
    ["09:00", String.raw`9\:00 AM`],
    ["12:00", String.raw`12\:00 PM`],
    ["17:30", String.raw`5\:30 PM`],
    ["23:59", String.raw`11\:59 PM`],
  ])("shows %s as %s", (stored, shown) => {
    expect(text(pickupTimeText(stored))).toBe(shown);
  });

  it("shows a value that is not a time escaped, rather than hiding it", () => {
    expect(text(pickupTimeText("**25:00**"))).toBe(String.raw`\*\*25\:00\*\*`);
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
      String.raw`⬜ Food pickup: at 5\:30 PM, <@${picker}>`,
    ]);
  });

  it("says what Food pickup still lacks", () => {
    expect(text(stepLine(workflow(), "food_pickup"))).toBe(
      "⬜ Food pickup: time not set, nobody assigned",
    );
    expect(text(stepLine(workflow(), "budget_approved"))).toBe(
      "⬜ Budget approved",
    );
  });

  it("names nobody when a step has no one", () => {
    expect(text(ownersText([]))).toBe("nobody assigned");
    expect(stepOwnerIds(workflow(), "engage_post")).toEqual([]);
  });

  it("pings nobody when the lines are sent", () => {
    const person = fakeId();
    const body = channelMessage({
      content: safe`${checklistLines(workflow([], [{ kind: "budget_sheet", user_id: person }]))[1] ?? safe`-`}`,
      mentionUserIds: [],
    }).payload as { allowed_mentions: unknown };

    expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
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

  it("offers one button for each open step that has one", () => {
    expect(ids(workflow())).toEqual([
      `event.sheet-done:${EVENT_ID}`,
      `event.engage-done:${EVENT_ID}`,
      `event.budget-ok:${EVENT_ID}`,
    ]);
  });

  it("hides the button of a done step, and the row once all are done", () => {
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

  it("does not offer Food pickup, which has no button", () => {
    expect(isStepDone(workflow(["food_pickup"]), "food_pickup")).toBe(true);
    expect(ids(workflow())).toHaveLength(3);
  });

  it.each(["", "x:y", "__proto__", "1"])(
    "refuses to build a button for %j",
    (id) => {
      expect(() => stepButtonId("budget_sheet", id)).toThrow(RangeError);
    },
  );
});
