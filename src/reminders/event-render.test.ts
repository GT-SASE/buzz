import { describe, expect, it } from "bun:test";
import type { EventReminderCandidate, EventStepKind } from "../db/types.ts";
import { safeTextValue } from "../discord/safe-text.ts";
import { parseIsoDate, type DateOnly } from "../lib/dates.ts";
import {
  EventRenderError,
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

  it("refuses to write a list once only Food pickup is open", () => {
    expect(() =>
      renderDailySteps(
        candidate({}, ["budget_sheet", "engage_post", "budget_approved"]),
        TODAY,
      ),
    ).toThrow(EventRenderError);
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
        `<@${ALICE}> <@${BOB}> you are on food pickup at ${at("2026-11-17T22:30:00Z")}, on Tue, Nov 17, in 2 days.`,
      ].join("\n"),
    );
    expect(rendered.mentionUserIds).toEqual([ALICE, BOB]);
    expect(rendered.mentionRoleIds).toEqual([]);
  });

  it("gives the time in the guild's zone with the offset on the event's date", () => {
    expect(
      safeTextValue(renderPickup(ready({ event_date: TODAY }), TODAY).content),
    ).toContain(`at ${at("2026-11-15T22:30:00Z")}, today, Sun, Nov 15.`);
    const summer = ready({ event_date: date("2026-06-03") });
    expect(
      safeTextValue(renderPickup(summer, date("2026-06-01")).content),
    ).toContain(`at ${at("2026-06-03T21:30:00Z")}, on Wed, Jun 3`);
    const singapore = ready({ timezone: "Asia/Singapore" });
    expect(safeTextValue(renderPickup(singapore, TODAY).content)).toContain(
      `at ${at("2026-11-17T09:30:00Z")},`,
    );
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
