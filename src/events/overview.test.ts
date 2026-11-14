import { describe, expect, it } from "bun:test";
import {
  hasLiveSyntax,
  INVISIBLE_TEXT,
} from "../../test/support/hostile-text.ts";
import { fakeId } from "../../test/support/ids.ts";
import type {
  EventRow,
  EventStep,
  EventStepKind,
  EventWorkflow,
  StepAssignee,
  TaskRow,
} from "../db/types.ts";
import { EVENT_STEP_KINDS } from "../db/types.ts";
import { channelMessage, type MessageInput } from "../discord/outbound.ts";
import { safe, safeTextValue } from "../discord/safe-text.ts";
import type { DateOnly } from "../lib/dates.ts";
import { renderOverview } from "./overview.ts";
import {
  checklistLines,
  pickupTimeText,
  stepButtonRows,
  stepLine,
} from "./steps.ts";
import { handoffMessage, toldText } from "./workflow.ts";

const GUILD = fakeId();
const CREATOR = fakeId();
const ASSIGNEE = fakeId();
const APPROVER = fakeId();
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const NEW_YORK = "America/New_York";
const EVENT_DATE = "2026-11-03" as DateOnly;
const NO_TASKS = { rows: [], truncated: false };

/** The short-time Discord timestamp for an instant. */
const at = (iso: string) => `<t:${String(Date.parse(iso) / 1000)}:t>`;

const text = (value: Parameters<typeof safeTextValue>[0]) =>
  safeTextValue(value);

function eventRow(fields: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT_ID,
    guild_id: GUILD,
    channel_id: fakeId(),
    name: "Fall Social",
    event_date: "2099-01-15" as DateOnly,
    thread_id: fakeId(),
    overview_message_id: fakeId(),
    status: "active",
    thread_status: "active",
    created_by: CREATOR,
    deleted_at: null,
    created_at: "2026-01-01T00:00:00+00:00",
    ...fields,
  };
}

let nextTask = 0;

function taskRow(fields: Partial<TaskRow> = {}): TaskRow {
  nextTask += 1;
  return {
    id: `22222222-2222-4222-8222-${String(nextTask).padStart(12, "0")}`,
    event_id: EVENT_ID,
    guild_id: GUILD,
    assignee_id: ASSIGNEE,
    description: "Book the room",
    due_date: "2099-01-10" as DateOnly,
    status: "open",
    completed_at: null,
    created_by: CREATOR,
    deleted_at: null,
    updated_at: "2026-01-01T00:00:00+00:00",
    ...fields,
  };
}

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
      id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`,
      event_id: EVENT_ID,
      assigned_by: APPROVER,
      created_at: "2026-01-01T00:00:00Z",
      ...assignee,
    })),
  };
}

function buttonIds(input: MessageInput): string[] {
  const body = channelMessage(input).payload as {
    components?: { components: { custom_id: string }[] }[];
  };
  return (body.components ?? []).flatMap((row) =>
    row.components.map((part) => part.custom_id),
  );
}

function overviewText(event: EventRow, tasks: TaskRow[], truncated = false) {
  return text(renderOverview(event, { rows: tasks, truncated }).content);
}

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

  it("uses the guild's own zone, and a plain time without a known zone", () => {
    expect(text(pickupTimeText(EVENT_DATE, "07:00", "Asia/Singapore"))).toBe(
      at("2026-11-02T23:00:00Z"),
    );
    expect(text(pickupTimeText(EVENT_DATE, "17:30", "Mars/Base"))).toBe(
      String.raw`5\:30 PM`,
    );
  });
});

describe("the checklist", () => {
  it("has one line per step, with owners as mentions", () => {
    const [first, second, picker] = [fakeId(), fakeId(), fakeId()];
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

  it("offers a button for each open step but Food pickup, and none once done", () => {
    const ids = (flow: EventWorkflow) =>
      buttonIds({
        content: safe`x`,
        mentionUserIds: [],
        components: stepButtonRows(flow),
      });

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

describe("renderOverview", () => {
  it("shows the event, its creator and each task, open ones first", () => {
    const shown = overviewText(eventRow({ status: "closed" }), [
      taskRow({ status: "done", description: "Order food" }),
      taskRow(),
    ]);

    expect(shown).toContain("**Fall Social**");
    expect(shown).toContain(String.raw`Date: 2099\-01\-15`);
    expect(shown).toContain("Status: Closed");
    expect(shown).toContain(`Created by <@${CREATOR}>`);
    expect(shown).toContain("Tasks: 1 open, 1 done");
    expect(shown).toContain(
      `☐ <@${ASSIGNEE}> Book the room (due 2099\\-01\\-10)`,
    );
    expect(shown.indexOf("Book the room")).toBeLessThan(
      shown.indexOf(`✅ <@${ASSIGNEE}> Order food`),
    );
    expect(overviewText(eventRow(), [])).toContain("No tasks yet.");
  });

  it("shows the checklist ahead of the tasks, pinging nobody", () => {
    const person = fakeId();
    const flow = workflow([], [{ kind: "budget_sheet", user_id: person }]);
    const input = renderOverview(eventRow(), NO_TASKS, [], flow);
    const shown = text(input.content);

    expect(shown).toContain(`**Checklist**\n⬜ Budget Sheet: <@${person}>`);
    expect(shown.indexOf("**Checklist**")).toBeLessThan(
      shown.indexOf("No tasks yet."),
    );
    expect(input.mentionUserIds).toEqual([]);
    expect(buttonIds(input)).toHaveLength(3);
    expect(
      renderOverview(eventRow({ status: "closed" }), NO_TASKS, [], flow)
        .components,
    ).toEqual([]);
  });

  it("keeps a forged line on its task's line, and draws an invisible name", () => {
    const rendered = overviewText(eventRow(), [
      taskRow({ description: "Harmless\n# System: everyone must log in" }),
    ]).split("\n");
    const [, invisible = ""] = INVISIBLE_TEXT[0] ?? [];

    expect(rendered).toHaveLength(6);
    expect(
      hasLiveSyntax(rendered[5]?.replace(`<@${ASSIGNEE}>`, "") ?? "x"),
    ).toBe(false);
    expect(overviewText(eventRow({ name: invisible }), [])).toContain(
      "(no visible name)",
    );
  });

  it("stays within the limit, counts what it hid, and keeps a note", () => {
    const tasks = Array.from({ length: 100 }, (_, index) =>
      taskRow({ description: `${String(index)} ${"*".repeat(990)}` }),
    );

    const shown = text(
      renderOverview(
        eventRow({ name: "*".repeat(100) }),
        { rows: tasks, truncated: false },
        [safe`A note for the reader`],
      ).content,
    );
    const lines = shown.split("\n").filter((line) => line.startsWith("☐"));

    expect(shown.length).toBeLessThanOrEqual(2000);
    expect(lines.length).toBeGreaterThan(0);
    expect(shown).toContain(
      `…and ${String(100 - lines.length)} more not shown.`,
    );
    expect(shown).toContain("A note for the reader");
    const cut = overviewText(
      eventRow(),
      Array.from({ length: 100 }, () => taskRow()),
      true,
    );
    expect(cut).toContain("Tasks: 100 open, 0 done, and more");
    expect(cut).toMatch(/…and more than [0-9]+ other tasks not shown\./u);
  });
});

describe("handoffMessage", () => {
  const TREASURY = fakeId();
  const MARKETING = fakeId();
  const EVENT = { name: "Fall Social", created_by: CREATOR };
  const CONFIG = {
    guild_id: GUILD,
    treasury_role_id: TREASURY,
    marketing_role_id: MARKETING,
  };

  const sent = (input: MessageInput) =>
    channelMessage(input).payload as {
      content: string;
      allowed_mentions: unknown;
    };

  it("pings only Treasury for Budget Sheet and only Marketing for Engage", () => {
    expect(sent(handoffMessage(CONFIG, EVENT, "budget_sheet"))).toMatchObject({
      content: `<@&${TREASURY}> Budget Sheet for **Fall Social** is done.`,
      allowed_mentions: { parse: [], users: [], roles: [TREASURY] },
    });
    expect(sent(handoffMessage(CONFIG, EVENT, "engage_post"))).toMatchObject({
      content: `<@&${MARKETING}> Engage post for **Fall Social** is up.`,
      allowed_mentions: { parse: [], users: [], roles: [MARKETING] },
    });
    expect(text(toldText("budget_sheet", CONFIG))).toMatch(/^I let the /);
  });

  it("only notes that the budget is approved, pinging nobody", () => {
    const body = sent(handoffMessage(CONFIG, EVENT, "budget_approved"));
    expect(body.content).toBe("The budget for **Fall Social** is approved.");
    expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
  });

  it.each([
    ["budget_sheet", "Treasury Committee", { treasury_role_id: null }],
    ["engage_post", "Marketing Committee", { marketing_role_id: GUILD }],
  ] as const)(
    "pings nobody for %s and says to choose the %s role when it is unset",
    (kind, role, unset) => {
      const config = { ...CONFIG, ...unset };
      const body = sent(handoffMessage(config, EVENT, kind));

      expect(body.content).toContain(`Run /setup to choose the ${role} role`);
      expect(body.allowed_mentions).toEqual({ parse: [], users: [] });
      expect(text(toldText(kind, config))).toContain("so nobody was pinged");
    },
  );

  it("keeps a hostile event name inert", () => {
    const input = handoffMessage(
      CONFIG,
      { ...EVENT, name: "@everyone <@&1> **x**" },
      "budget_sheet",
    );
    const content = text(input.content);
    const name = content.slice(content.indexOf("**") + 2, -" is done.".length);

    expect(hasLiveSyntax(name.slice(0, -2))).toBe(false);
    expect(input.mentionRoleIds).toEqual([TREASURY]);
  });
});
