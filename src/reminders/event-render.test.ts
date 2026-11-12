import { describe, expect, it } from "vitest";
import { HOSTILE_TEXT } from "../../test/support/hostile-text.ts";
import type { EventReminderCandidate, EventStepKind } from "../db/types.ts";
import { channelMessage } from "../discord/outbound.ts";
import { safeTextValue } from "../discord/safe-text.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  EventRenderError,
  formatPickupTime,
  renderDailySteps,
  renderEventDay,
  renderPickup,
} from "./event-render.ts";
import { fakeId } from "../../test/support/ids.ts";

function date(value: string): DateOnly {
  const parsed = parseIsoDate(value);
  if (parsed === null) {
    throw new Error("bad test date");
  }
  return parsed;
}

const TODAY = date("2026-11-15");
const GUILD = fakeId(1);
const CREATOR = fakeId(2);
const ROLE = fakeId(3);
const ALICE = fakeId(10);
const BOB = fakeId(11);

function candidate(
  overrides: Partial<EventReminderCandidate> = {},
  done: readonly EventStepKind[] = [],
): EventReminderCandidate {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    guild_id: GUILD,
    name: "Spring social",
    event_date: date("2026-11-20"),
    thread_id: fakeId(4),
    thread_status: "active",
    created_by: CREATOR,
    thread_refusals: 0,
    pickup_time: null,
    timezone: "America/New_York",
    events_director_role_id: ROLE,
    steps: (
      ["budget_sheet", "engage_post", "budget_approved", "food_pickup"] as const
    ).map((kind) => ({ kind, status: done.includes(kind) ? "done" : "open" })),
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

describe("formatPickupTime", () => {
  it.each([
    ["00:00", "12:00 AM"],
    ["09:05", "9:05 AM"],
    ["11:59", "11:59 AM"],
    ["12:00", "12:00 PM"],
    ["17:30", "5:30 PM"],
    ["23:45", "11:45 PM"],
  ])("shows %s as %s", (value, shown) => {
    expect(formatPickupTime(value)).toBe(shown);
  });

  it.each(["24:00", "5:30", "17:30:00", "", "noon"])("refuses %j", (value) => {
    expect(() => formatPickupTime(value)).toThrow(EventRenderError);
  });
});

describe("renderEventDay", () => {
  it.each([
    ["2026-11-15", "today, Sun, Nov 15"],
    ["2026-11-16", "tomorrow, Mon, Nov 16"],
    ["2026-11-17", "on Tue, Nov 17, in 2 days"],
  ])("for %s", (eventDate, shown) => {
    expect(safeTextValue(renderEventDay(TODAY, date(eventDate)))).toBe(shown);
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
      TODAY,
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
      TODAY,
    );
    expect(safeTextValue(rendered.content)).toContain(
      `- Budget Sheet: nobody is on it yet, <@&${ROLE}> please assign someone`,
    );
    expect(rendered.mentionUserIds).toEqual([ALICE]);
    expect(rendered.mentionRoleIds).toEqual([ROLE]);
  });

  it("never mentions Food pickup or pings the creator", () => {
    const rendered = renderDailySteps(
      candidate({}, ["budget_sheet", "engage_post"]),
      TODAY,
    );
    const content = safeTextValue(rendered.content);
    expect(content).not.toMatch(/food pickup/i);
    expect(content).not.toContain(CREATOR);
    expect(rendered.mentionUserIds).toEqual([]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });

  it("has nothing to list once only Food pickup is open", () => {
    expect(() =>
      renderDailySteps(
        candidate({}, ["budget_sheet", "engage_post", "budget_approved"]),
        TODAY,
      ),
    ).toThrow(EventRenderError);
  });

  it("refuses to write a list with nothing on it", () => {
    expect(() => renderDailySteps(candidate({}, ALL_DONE), TODAY)).toThrow(
      EventRenderError,
    );
  });

  it.each(HOSTILE_TEXT)("keeps a hostile event name inert: %s", (_, name) => {
    const content = safeTextValue(
      renderDailySteps(candidate({ name }), TODAY).content,
    );
    const lines = content.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\*\*Still to do for /u);
    expect(content).not.toMatch(/(?<!\\)@(everyone|here)/u);
    // The only mentions are the ones the reminder adds.
    expect(content.match(/(?<!\\)<[@#][^>]*>/gu)).toEqual([
      `<@&${ROLE}>`,
      `<@&${ROLE}>`,
    ]);
  });

  it("fits the most people the steps allow in one valid message", () => {
    const people = Array.from({ length: 10 }, (_, index) =>
      fakeId(100 + index),
    );
    const others = Array.from({ length: 10 }, (_, index) =>
      fakeId(200 + index),
    );
    const rendered = renderDailySteps(
      candidate({
        name: "x".repeat(300),
        assignees: [
          ...people.map((user_id) => ({
            kind: "budget_sheet" as const,
            user_id,
          })),
          ...others.map((user_id) => ({
            kind: "engage_post" as const,
            user_id,
          })),
        ],
      }),
      TODAY,
    );
    expect(() =>
      channelMessage({
        content: rendered.content,
        mentionUserIds: rendered.mentionUserIds,
        mentionRoleIds: rendered.mentionRoleIds,
        roleGuildId: GUILD,
      }),
    ).not.toThrow();
    expect(rendered.mentionUserIds).toHaveLength(20);
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
    const rendered = renderPickup(ready(), TODAY);
    expect(safeTextValue(rendered.content)).toBe(
      [
        "**Food pickup for Spring social**",
        `<@${ALICE}> <@${BOB}> you are on food pickup at 5\\:30 PM, on Tue, Nov 17, in 2 days.`,
      ].join("\n"),
    );
    expect(rendered.mentionUserIds).toEqual([ALICE, BOB]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });

  it("says today on the day", () => {
    expect(
      safeTextValue(renderPickup(ready({ event_date: TODAY }), TODAY).content),
    ).toContain("at 5\\:30 PM, today, Sun, Nov 15.");
  });

  it("refuses when Food pickup is not set up", () => {
    expect(() => renderPickup(ready({ pickup_time: null }), TODAY)).toThrow(
      EventRenderError,
    );
    expect(() => renderPickup(ready({ assignees: [] }), TODAY)).toThrow(
      EventRenderError,
    );
  });
});
