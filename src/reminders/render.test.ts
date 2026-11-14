import { describe, expect, it } from "bun:test";
import type { EventReminderCandidate, EventStepKind } from "../db/types.ts";
import { HOSTILE_TEXT } from "../../test/support/hostile-text.ts";
import { safe, safeTextValue, type ChunkLine } from "../discord/safe-text.ts";
import { channelMessage } from "../discord/outbound.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  renderDailySteps,
  renderEventDay,
  renderPickup,
} from "./event-render.ts";
import {
  packBatches,
  renderDue,
  renderEventHeader,
  renderMessages,
  renderReminderLine,
} from "./render.ts";
import { fakeId } from "../../test/support/ids.ts";

function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) {
    throw new Error("bad test date");
  }
  return parsed;
}

const TODAY = date("2026-11-04");
const USER = fakeId(1);
const TASK = "11111111-1111-4111-8111-111111111111";

function reminder(description: string, assigneeId = USER) {
  return renderReminderLine({
    taskId: TASK,
    assigneeId,
    description,
    dueDate: date("2026-11-05"),
    today: TODAY,
  });
}

function line(description: string, assigneeId = USER): ChunkLine {
  return reminder(description, assigneeId).line;
}

function text(chunkLine: ChunkLine): string {
  return safeTextValue(chunkLine.text);
}

/** Removes every escape, leaving only syntax Discord would still act on. */
function withoutEscaped(value: string): string {
  return value.replace(/\\[\s\S]/g, "");
}

describe("renderDue", () => {
  it.each([
    ["2026-11-07", "due Nov 7, 2026, 3 days left"],
    ["2026-11-04", "due today, Nov 4, 2026"],
    ["2026-11-03", "was due Nov 3, 2026, 1 day ago"],
  ])("says when %s is due", (due, expected) => {
    expect(safeTextValue(renderDue(TODAY, date(due)))).toBe(expected);
  });

  it("counts across a change of clocks by calendar day", () => {
    expect(
      safeTextValue(renderDue(date("2026-03-08"), date("2026-03-09"))),
    ).toContain("1 day left");
    expect(
      safeTextValue(renderDue(date("2026-11-01"), date("2026-11-02"))),
    ).toContain("1 day left");
  });
});

describe("hostile task text", () => {
  it.each([
    "@everyone @here",
    "<@&123456789012345>",
    "[Portal login required](https://evil.example)",
    "line one\n# line two\n> line three",
    "reversed ‮text‬",
  ])("makes %j inert", (description) => {
    const rendered = text(line(description));
    const active = withoutEscaped(rendered).replace(`<@${USER}>`, "");
    expect(active).not.toMatch(/[<>[\]()*_~`|#@\n]/);
    expect(rendered.includes("‮")).toBe(false);
  });

  it("pings only the assignee, whatever the text names", () => {
    const rendered = line(`<@${fakeId(2)}> @everyone`);
    expect(rendered.mentionUserIds).toEqual([USER]);
    const [message] = renderMessages(renderEventHeader("Meeting"), [rendered]);
    if (message === undefined) {
      throw new Error("expected a message");
    }
    expect(channelMessage(message).payload).toMatchObject({
      allowed_mentions: { parse: [], users: [USER] },
      flags: 4,
    });
  });

  it("makes a hostile event name inert", () => {
    const header = renderEventHeader("@everyone [x](https://evil.example)");
    const active = withoutEscaped(text(header));
    expect(active.replaceAll("**", "")).not.toMatch(/[<>[\]()@]/);
    expect(header.mentionUserIds).toEqual([]);
  });
});

describe("text with nothing visible", () => {
  it("still produces a reminder, with a stand-in", () => {
    const rendered = reminder("​​");
    expect(rendered.usedStandIn).toBe(true);
    expect(text(rendered.line)).toContain("no readable description");
    expect(text(rendered.line)).toContain("Nov 5, 2026");
  });

  it("uses a plain header for an unreadable event name", () => {
    expect(text(renderEventHeader("​"))).toBe("**Task reminders**");
  });
});

describe("packBatches", () => {
  const header = renderEventHeader("Meeting");
  const asLine = (value: ChunkLine) => value;

  it("holds five tasks to a message, one row of buttons each", () => {
    const lines = Array.from({ length: 12 }, () => line("t"));
    const batches = packBatches(header, lines, asLine);
    expect(batches.map((batch) => batch.items.length)).toEqual([5, 5, 2]);
  });

  it("starts a new batch at the length and mention limits", () => {
    const long = Array.from({ length: 5 }, () => line("x".repeat(900)));
    const many = Array.from({ length: 250 }, (_, index) =>
      line("t", fakeId(index + 10)),
    );
    for (const lines of [long, many]) {
      const batches = packBatches(header, lines, asLine);
      expect(batches.length).toBeGreaterThan(1);
      expect(batches.flatMap((batch) => batch.items)).toEqual(lines);
      for (const batch of batches) {
        expect(batch.messages).toHaveLength(1);
        const [message] = batch.messages;
        expect(
          safeTextValue(message?.content as never).length,
        ).toBeLessThanOrEqual(2000);
        expect(message?.mentionUserIds.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it("keeps a long item alone and splits it without a lone header", () => {
    const long = line("word ".repeat(1000));
    const short = line("Short");
    const batches = packBatches(header, [short, long, short], asLine);
    expect(batches.map((batch) => batch.items.length)).toEqual([1, 1, 1]);
    const split = batches[1]?.messages ?? [];
    expect(split.length).toBeGreaterThan(1);
    const first = safeTextValue(split[0]?.content as never);
    expect(first).toContain("Task reminders");
    expect(first).toContain("word");
    expect(split.flatMap((message) => message.mentionUserIds)).toEqual([USER]);
  });
});

describe("the Mark done button", () => {
  function button(description: string) {
    const body = channelMessage({
      content: safe`x`,
      mentionUserIds: [],
      components: [reminder(description).row],
    }).payload as {
      components: { components: { custom_id: string; label: string }[] }[];
    };
    return body.components[0]?.components[0];
  }

  it("names the task, and refers to it by ID alone", () => {
    expect(button("Book the room")).toMatchObject({
      custom_id: `task.done:${TASK}`,
      label: "✅ Done - Book the room",
    });
  });

  it.each(
    HOSTILE_TEXT.filter(([name]) =>
      ["everyone ping", "masked link", "forged line"].includes(name),
    ),
  )("keeps a label inert: %s", (_label, description) => {
    expect(button(description)?.label ?? "").not.toMatch(
      /[@<>#[\]`|*~:/\\.\n\r]/u,
    );
  });

  it("falls back to plain words for invisible text", () => {
    expect(button("ㅤ")?.label).toBe("✅ Mark done");
  });
});

// The event step and Food pickup reminders.
const DAY = date("2026-11-15");
const CREATOR = fakeId(2);
const ROLE = fakeId(3);
const ALICE = fakeId(10);
const BOB = fakeId(11);
const ALL_DONE: EventStepKind[] = [
  "budget_sheet",
  "engage_post",
  "budget_approved",
  "food_pickup",
];

function candidate(
  overrides: Partial<EventReminderCandidate> = {},
  done: readonly EventStepKind[] = [],
): EventReminderCandidate {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    guild_id: fakeId(1),
    name: "Spring social",
    event_date: date("2026-11-20"),
    thread_id: fakeId(4),
    thread_status: "active",
    created_by: CREATOR,
    pickup_time: null,
    timezone: "America/New_York",
    events_director_role_id: ROLE,
    steps: ALL_DONE.map((kind) => ({
      kind,
      status: done.includes(kind) ? "done" : "open",
    })),
    assignees: [],
    log: [],
    ...overrides,
  };
}

/** The short-time Discord timestamp for an instant. */
const at = (iso: string) => `<t:${String(Date.parse(iso) / 1000)}:t>`;

describe("renderEventDay", () => {
  it.each([
    ["2026-11-15", "today, Sun, Nov 15"],
    ["2026-11-16", "tomorrow, Mon, Nov 16"],
    ["2026-11-17", "on Tue, Nov 17, in 2 days"],
  ])("for %s", (eventDate, shown) => {
    expect(safeTextValue(renderEventDay(DAY, date(eventDate)))).toBe(shown);
  });
});

describe("renderDailySteps", () => {
  it("pings each step's people, and lists approval without a ping", () => {
    const rendered = renderDailySteps(
      candidate({
        assignees: [
          { kind: "budget_sheet", user_id: ALICE },
          { kind: "budget_sheet", user_id: BOB },
          { kind: "engage_post", user_id: BOB },
        ],
      }),
      DAY,
    );
    expect(safeTextValue(rendered.content)).toBe(
      [
        "**Still to do for Spring social** (on Fri, Nov 20, in 5 days)",
        `- Budget Sheet: <@${ALICE}> <@${BOB}>`,
        `- Engage post: <@${BOB}>`,
        "- Budget approved: waiting for approval",
      ].join("\n"),
    );
    expect(rendered.mentionUserIds).toEqual([ALICE, BOB]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });

  it("pings the Events Directors role only for a step nobody is on", () => {
    const rendered = renderDailySteps(
      candidate({ assignees: [{ kind: "engage_post", user_id: ALICE }] }),
      DAY,
    );
    expect(safeTextValue(rendered.content)).toContain(
      `- Budget Sheet: nobody is on it yet, <@&${ROLE}> please assign someone`,
    );
    expect(rendered.mentionRoleIds).toEqual([ROLE]);
  });

  it("never mentions Food pickup or pings the creator", () => {
    const rendered = renderDailySteps(
      candidate({}, ["budget_sheet", "engage_post"]),
      DAY,
    );
    const content = safeTextValue(rendered.content);
    expect(content).not.toMatch(/food pickup/i);
    expect(content).not.toContain(CREATOR);
    expect(rendered.mentionUserIds).toEqual([]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });
});

describe("renderPickup", () => {
  const ready = (overrides: Partial<EventReminderCandidate> = {}) =>
    candidate(
      {
        event_date: date("2026-11-17"),
        pickup_time: "17:30",
        assignees: [
          { kind: "food_pickup", user_id: ALICE },
          { kind: "food_pickup", user_id: BOB },
          { kind: "budget_sheet", user_id: CREATOR },
        ],
        ...overrides,
      },
      ALL_DONE,
    );

  it("pings every pickup person with the time and the day", () => {
    const rendered = renderPickup(ready(), DAY);
    expect(safeTextValue(rendered.content)).toBe(
      [
        "**Food pickup for Spring social**",
        `<@${ALICE}> <@${BOB}> you are on food pickup at ${at("2026-11-17T22:30:00Z")}, on Tue, Nov 17, in 2 days.`,
      ].join("\n"),
    );
    expect(rendered.mentionUserIds).toEqual([ALICE, BOB]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });

  it("gives the time in the guild's zone with the offset on the event's date", () => {
    expect(
      safeTextValue(renderPickup(ready({ event_date: DAY }), DAY).content),
    ).toContain(`at ${at("2026-11-15T22:30:00Z")}, today, Sun, Nov 15.`);
    const summer = ready({ event_date: date("2026-06-03") });
    expect(
      safeTextValue(renderPickup(summer, date("2026-06-01")).content),
    ).toContain(`at ${at("2026-06-03T21:30:00Z")}, on Wed, Jun 3`);
    const singapore = ready({ timezone: "Asia/Singapore" });
    expect(safeTextValue(renderPickup(singapore, DAY).content)).toContain(
      `at ${at("2026-11-17T09:30:00Z")},`,
    );
  });
});
