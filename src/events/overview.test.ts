import { describe, expect, it } from "vitest";
import {
  HOSTILE_TEXT,
  hasLiveSyntax,
  INVISIBLE_TEXT,
} from "../../test/support/hostile-text.ts";
import { fakeId } from "../../test/support/ids.ts";
import { safe, safeTextValue } from "../discord/safe-text.ts";
import type { EventRow, EventWorkflow, TaskRow } from "../db/types.ts";
import { EVENT_STEP_KINDS } from "../db/types.ts";
import { channelMessage } from "../discord/outbound.ts";
import type { DateOnly } from "../lib/dates.ts";
import { fitLines, renderOverview } from "./overview.ts";

const GUILD = fakeId();
const FORUM = fakeId();
const THREAD = fakeId();
const OVERVIEW = fakeId();
const CREATOR = fakeId();
const ASSIGNEE = fakeId();
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function eventRow(fields: Partial<EventRow> = {}): EventRow {
  return {
    id: EVENT_ID,
    guild_id: GUILD,
    channel_id: FORUM,
    name: "Fall Social",
    event_date: "2099-01-15" as DateOnly,
    thread_id: THREAD,
    overview_message_id: OVERVIEW,
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

function textOf(event: EventRow, tasks: TaskRow[], truncated = false): string {
  return safeTextValue(
    renderOverview(event, { rows: tasks, truncated }).content,
  );
}

describe("renderOverview with the event's workflow", () => {
  const PERSON = fakeId();
  const flow = (done: readonly string[] = []): EventWorkflow => ({
    event_id: EVENT_ID,
    event_date: eventRow().event_date,
    pickup_time: null,
    timezone: "America/New_York",
    steps: EVENT_STEP_KINDS.map((kind) => ({
      event_id: EVENT_ID,
      kind,
      status: done.includes(kind) ? ("done" as const) : ("open" as const),
      completed_at: done.includes(kind) ? "2026-01-01T00:00:00Z" : null,
      completed_by: done.includes(kind) ? CREATOR : null,
      handoff_claimed_at: null,
      handoff_sent_at: null,
    })),
    assignees: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        event_id: EVENT_ID,
        kind: "budget_sheet",
        user_id: PERSON,
        assigned_by: CREATOR,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  const NO_TASKS = { rows: [], truncated: false };

  function ids(input: ReturnType<typeof renderOverview>): string[] {
    const body = channelMessage(input).payload as {
      components?: { components: { custom_id: string }[] }[];
    };
    return (body.components ?? []).flatMap((row) =>
      row.components.map((part) => part.custom_id),
    );
  }

  it("shows the checklist ahead of the tasks, and pings nobody", () => {
    const input = renderOverview(eventRow(), NO_TASKS, [], flow());
    const text = safeTextValue(input.content);

    expect(text).toContain(`**Checklist**\n⬜ Budget Sheet: <@${PERSON}>`);
    expect(text.indexOf("**Checklist**")).toBeLessThan(
      text.indexOf("No tasks yet."),
    );
    expect(input.mentionUserIds).toEqual([]);
    expect(ids(input)).toHaveLength(3);
  });

  it("hides the buttons of done steps, and all of them on a closed event", () => {
    expect(
      ids(renderOverview(eventRow(), NO_TASKS, [], flow(["budget_sheet"]))),
    ).toEqual([`event.engage-done:${EVENT_ID}`, `event.budget-ok:${EVENT_ID}`]);
    const closed = renderOverview(
      eventRow({ status: "closed" }),
      NO_TASKS,
      [],
      flow(),
    );
    expect(closed.components).toEqual([]);
  });

  it("draws no buttons for a workflow of another event", () => {
    const input = renderOverview(
      eventRow({ id: "44444444-4444-4444-8444-444444444444" }),
      NO_TASKS,
      [],
      flow(),
    );

    expect(input.components).toEqual([]);
  });

  it("takes every button away when the workflow could not be read", () => {
    expect(renderOverview(eventRow(), NO_TASKS).components).toEqual([]);
    expect(
      renderOverview(eventRow({ status: "closed" }), NO_TASKS).components,
    ).toEqual([]);
  });
});

describe("renderOverview", () => {
  it("shows the event, its creator and each task's state and date", () => {
    const text = textOf(eventRow(), [
      taskRow(),
      taskRow({ status: "done", description: "Order food" }),
    ]);

    expect(text).toContain("**Fall Social**");
    expect(text).toContain(String.raw`Date: 2099\-01\-15`);
    expect(text).toContain("Status: Active");
    expect(text).toContain(`Created by <@${CREATOR}>`);
    expect(text).toContain("Tasks: 1 open, 1 done");
    expect(text).toContain(
      String.raw`☐ <@${ASSIGNEE}> Book the room (due 2099\-01\-10)`,
    );
    expect(text).toContain(`✅ <@${ASSIGNEE}> Order food`);
  });

  it("says when an event has no tasks and when it is closed", () => {
    const text = textOf(eventRow({ status: "closed" }), []);

    expect(text).toContain("Status: Closed");
    expect(text).toContain("No tasks yet.");
  });

  it("never pings, whoever is shown", () => {
    const input = renderOverview(eventRow(), {
      rows: [taskRow()],
      truncated: false,
    });

    expect(input.mentionUserIds).toEqual([]);
  });

  it("puts open tasks ahead of done ones", () => {
    const text = textOf(eventRow(), [
      taskRow({ status: "done", description: "Finished" }),
      taskRow({ description: "Still open" }),
    ]);

    expect(text.indexOf("Still open")).toBeLessThan(text.indexOf("Finished"));
  });

  it.each(HOSTILE_TEXT)("keeps a hostile name inert: %s", (_label, name) => {
    const [title = ""] = textOf(eventRow({ name }), []).split("\n");

    expect(hasLiveSyntax(title.slice(2, -2))).toBe(false);
  });

  it.each(HOSTILE_TEXT)("keeps a hostile task inert: %s", (_label, text) => {
    const rendered = textOf(eventRow(), [
      taskRow({ assignee_id: ASSIGNEE, description: text }),
    ]).split("\n");

    // A forged line stays on the task's own line.
    expect(rendered).toHaveLength(6);
    expect(
      hasLiveSyntax(rendered[5]?.replace(`<@${ASSIGNEE}>`, "") ?? "x"),
    ).toBe(false);
  });

  it.each(INVISIBLE_TEXT)("draws an event whose name is %s", (_label, name) => {
    expect(textOf(eventRow({ name }), [])).toContain("(no visible name)");
  });

  it.each(INVISIBLE_TEXT)(
    "does not let a task of %s stop the others",
    (_label, description) => {
      const text = textOf(eventRow(), [
        taskRow({ description }),
        taskRow({ description: "Book the room" }),
      ]);

      expect(text).toContain("Book the room");
    },
  );

  it("cuts a long description to one short line", () => {
    const text = textOf(eventRow(), [
      taskRow({ description: "x".repeat(1000) }),
    ]);

    expect(text.split("\n").at(-1)?.length).toBeLessThan(300);
    expect(text).toContain("…");
  });

  it("stays within the limit and counts what it hid", () => {
    const tasks = Array.from({ length: 100 }, (_, index) =>
      taskRow({ description: `${String(index)} ${"*".repeat(990)}` }),
    );

    const text = textOf(eventRow(), tasks);
    const shown = text.split("\n").filter((line) => line.startsWith("☐"));

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(100);
    expect(text).toContain(
      `…and ${String(100 - shown.length)} more not shown.`,
    );
  });

  it("stays within the limit at the longest possible name", () => {
    const text = textOf(
      eventRow({ name: "*".repeat(100) }),
      Array.from({ length: 100 }, () => taskRow()),
    );

    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("more not shown.");
  });

  it("says so when the database held more tasks than were read", () => {
    const tasks = Array.from({ length: 100 }, () => taskRow());

    const text = textOf(eventRow(), tasks, true);

    expect(text).toContain("Tasks: 100 open, 0 done, and more");
    expect(text).toMatch(/…and more than [0-9]+ other tasks not shown\./u);
  });

  it("hides nothing and adds no closing line when all fits", () => {
    const text = textOf(eventRow(), [taskRow()]);

    expect(text).not.toContain("not shown");
  });

  it("keeps a note whatever else is cut", () => {
    const input = renderOverview(
      eventRow(),
      {
        rows: Array.from({ length: 100 }, () => taskRow()),
        truncated: false,
      },
      [safe`A note for the reader`],
    );

    expect(safeTextValue(input.content)).toContain("A note for the reader");
  });
});

describe("fitLines", () => {
  const more = (count: number) => (count === 0 ? undefined : safe`hidden`);

  it("refuses plain strings at compile time", () => {
    // @ts-expect-error a stored string has to pass the render boundary first
    expect(() => fitLines(["plain"], [], more)).toThrow();
  });

  it("uses the whole limit when the closing line is not needed", () => {
    const text = fitLines([safe`aaaa`], [safe`bbbb`], more, 9);

    expect(safeTextValue(text)).toBe("aaaa\nbbbb");
  });

  it("makes room for the closing line", () => {
    const text = fitLines([safe`aaaa`], [safe`bbbb`], more, 8);

    expect(safeTextValue(text)).toBe("aaaa\nhidden");
  });
});
