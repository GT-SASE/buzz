/**
 * What the event workflow functions refuse before any query, and how they read the
 * answers. test/db covers what the database does with them.
 */

import { describe, expect, it } from "vitest";
import { fakeId } from "../../test/support/ids.ts";
import { serverError } from "../../test/support/sql-client.ts";
import { stubDb } from "../../test/support/stub-db.ts";
import type { DbClient } from "./client.ts";
import type { DateOnly } from "../lib/dates.ts";
import {
  assignEventStep,
  completeEventStep,
  getEventWorkflow,
  listEventReminderCandidates,
  listEventWorkflows,
  listOpenStepsForUser,
  setEventPickupTime,
  unassignEventStep,
} from "./event-steps.ts";
import {
  draftRoles,
  getSetupDraft,
  saveSetupDraft,
  setupDraftFingerprint,
  type SetupRoles,
} from "./guild-config.ts";

const GUILD = fakeId();
const ACTOR = fakeId();
const USER = fakeId();
const ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "11111111-2222-4333-8444-666666666666";
const TOKEN = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const DATE = "2030-01-10" as DateOnly;
const NOW = new Date("2030-01-01T12:00:00.000Z");
const CREATED = "2030-01-01T11:00:00.123456+00:00";

const ROLES: SetupRoles = {
  officerRoleId: fakeId(),
  adminRoleId: fakeId(),
  eboardRoleId: fakeId(),
  eventsCommitteeRoleId: fakeId(),
  treasuryRoleId: fakeId(),
  marketingRoleId: fakeId(),
};

function step(kind: string, status = "open") {
  return {
    event_id: ID,
    kind,
    status,
    completed_at: status === "done" ? CREATED : null,
    completed_by: status === "done" ? ACTOR : null,
    handoff_claimed_at: null,
    handoff_sent_at: null,
  };
}

function assignee(id: string, kind: string, createdAt: string) {
  return {
    id,
    event_id: ID,
    kind,
    user_id: USER,
    assigned_by: ACTOR,
    created_at: createdAt,
  };
}

function workflowRow() {
  return {
    id: ID,
    pickup_time: "17:30:00",
    // Out of order on purpose: the reader puts them in the order of the kinds.
    steps: [
      step("food_pickup"),
      step("budget_approved", "done"),
      step("engage_post"),
      step("budget_sheet", "done"),
    ],
    // The read returns these oldest first.
    assignees: [
      assignee(ID, "budget_sheet", "2030-01-01T00:00:00+00:00"),
      assignee(OTHER_ID, "engage_post", "2030-01-02T00:00:00+00:00"),
    ],
  };
}

const assignment = {
  guildId: GUILD,
  eventId: ID,
  kind: "budget_sheet" as const,
  userId: USER,
  actorId: ACTOR,
};

describe("refusals before any query", () => {
  it.each(["5:30", "24:00", "17:60", "17:30:00", "5:30 PM", " 17:30"])(
    "refuses the pickup time %j",
    async (pickupTime) => {
      const { db, calls } = stubDb();
      const result = await setEventPickupTime(db, {
        guildId: GUILD,
        eventId: ID,
        pickupTime,
        actorId: ACTOR,
      });
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it("reads nothing for no events", async () => {
    const { db, calls } = stubDb();
    expect(
      await listEventWorkflows(db, { guildId: GUILD, eventIds: [] }),
    ).toEqual({ ok: true, value: [] });
    expect(calls).toEqual([]);
  });
});

describe("reading answers", () => {
  it("orders a workflow's steps by kind and its people oldest first, as HH:MM", async () => {
    const { db } = stubDb(() => ({ rows: [workflowRow()] }));
    const result = await getEventWorkflow(db, { guildId: GUILD, eventId: ID });
    expect(result.ok).toBe(true);
    const workflow = result.ok ? result.value : null;
    expect(workflow?.pickup_time).toBe("17:30");
    expect(workflow?.steps.map((row) => [row.kind, row.status])).toEqual([
      ["budget_sheet", "done"],
      ["engage_post", "open"],
      ["budget_approved", "done"],
      ["food_pickup", "open"],
    ]);
    expect(workflow?.assignees.map((row) => row.kind)).toEqual([
      "budget_sheet",
      "engage_post",
    ]);
  });

  it("returns null for an event that is not there", async () => {
    const { db } = stubDb(() => ({ rows: [] }));
    expect(await getEventWorkflow(db, { guildId: GUILD, eventId: ID })).toEqual(
      { ok: true, value: null },
    );
  });

  it.each([
    ["assignEventStep", (db: DbClient) => assignEventStep(db, assignment)],
    ["unassignEventStep", (db: DbClient) => unassignEventStep(db, assignment)],
    [
      "completeEventStep",
      (db: DbClient) =>
        completeEventStep(db, {
          guildId: GUILD,
          eventId: ID,
          kind: "budget_sheet",
          actorId: ACTOR,
        }),
    ],
    [
      "setEventPickupTime",
      (db: DbClient) =>
        setEventPickupTime(db, {
          guildId: GUILD,
          eventId: ID,
          pickupTime: "09:05",
          actorId: ACTOR,
        }),
    ],
  ])("reports a null from %s as not found", async (_name, call) => {
    const { db } = stubDb(() => ({ rows: [{ value: null }] }));
    expect(await call(db)).toEqual({
      ok: false,
      error: { category: "not_found", code: null },
    });
  });

  it.each([
    ["CF431", "step_assignee_limit"],
    ["CF410", "parent_unavailable"],
  ])("reports %s as %s", async (code, category) => {
    const { db } = stubDb(() => serverError(code));
    expect(await assignEventStep(db, assignment)).toEqual({
      ok: false,
      error: { category, code },
    });
  });

  it("lists upcoming events soonest first, then past ones, as HH:MM", async () => {
    const row = (id: string, date: string, kind: string) => ({
      assignment_id: id,
      kind,
      event_id: id,
      event_name: "Social",
      event_date: date,
      pickup_time: kind === "food_pickup" ? "17:30:00" : null,
      step_status: "open",
    });
    const { db } = stubDb(() => ({
      rows: [
        row(ID, "2030-02-01", "budget_sheet"),
        row(TOKEN, "2030-01-01", "budget_sheet"),
        row(OTHER_ID, "2030-01-20", "food_pickup"),
        row(SECOND_ID, "2030-01-20", "engage_post"),
      ],
    }));
    const result = await listOpenStepsForUser(db, {
      guildId: GUILD,
      userId: USER,
      today: DATE,
    });
    expect(
      result.ok
        ? result.value.rows.map((each) => [
            each.event_date,
            each.kind,
            each.pickup_time,
          ])
        : null,
    ).toEqual([
      ["2030-01-20", "engage_post", null],
      ["2030-01-20", "food_pickup", "17:30"],
      ["2030-02-01", "budget_sheet", null],
      ["2030-01-01", "budget_sheet", null],
    ]);
  });

  it("reads a reminder candidate with its guild's zone and Events Directors role", async () => {
    const role = fakeId();
    const { db } = stubDb(() => ({
      rows: [
        {
          id: ID,
          guild_id: GUILD,
          name: "Social",
          event_date: DATE,
          thread_id: USER,
          thread_status: "active",
          created_by: ACTOR,
          thread_refusals: 0,
          pickup_time: "09:05:00",
          timezone: "America/New_York",
          events_director_role_id: role,
          steps: [{ kind: "budget_sheet", status: "open" }],
          assignees: [
            { kind: "food_pickup", user_id: ACTOR },
            { kind: "budget_sheet", user_id: USER },
          ],
          log: [
            {
              kind: "daily_steps",
              reminder_date: DATE,
              state: "sent",
              claimed_at: CREATED,
            },
          ],
        },
      ],
    }));
    const result = await listEventReminderCandidates(db, { fromDate: DATE });
    expect(result.ok && result.value.rows[0]).toMatchObject({
      timezone: "America/New_York",
      events_director_role_id: role,
      pickup_time: "09:05",
      assignees: [
        { kind: "food_pickup", user_id: ACTOR },
        { kind: "budget_sheet", user_id: USER },
      ],
      log: [{ kind: "daily_steps", reminder_date: DATE, state: "sent" }],
    });
  });
});

const SECOND_ID = "11111111-2222-4333-8444-888888888888";

describe("setup drafts", () => {
  function draftRow(fields: Record<string, unknown> = {}) {
    return {
      guild_id: GUILD,
      actor_id: ACTOR,
      officer_role_id: ROLES.officerRoleId,
      admin_role_id: ROLES.adminRoleId,
      eboard_role_id: ROLES.eboardRoleId,
      events_committee_role_id: ROLES.eventsCommitteeRoleId,
      treasury_role_id: ROLES.treasuryRoleId,
      marketing_role_id: ROLES.marketingRoleId,
      fingerprint: setupDraftFingerprint(ROLES),
      created_at: CREATED,
      ...fields,
    };
  }

  it("fingerprints the six roles in order, in a short custom_id-safe form", () => {
    const fingerprint = setupDraftFingerprint(ROLES);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(setupDraftFingerprint({ ...ROLES })).toBe(fingerprint);
    expect(
      setupDraftFingerprint({
        ...ROLES,
        treasuryRoleId: ROLES.marketingRoleId,
        marketingRoleId: ROLES.treasuryRoleId,
      }),
    ).not.toBe(fingerprint);
  });

  it("returns the fingerprint it saved", async () => {
    const { db } = stubDb(() => ({ rows: [{ value: true }] }));
    expect(
      await saveSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        roles: ROLES,
      }),
    ).toEqual({ ok: true, value: setupDraftFingerprint(ROLES) });
  });

  it("reads a draft back, and gives its roles in the bindings' shape", async () => {
    const { db } = stubDb(() => ({ rows: [draftRow()] }));
    const result = await getSetupDraft(db, {
      guildId: GUILD,
      actorId: ACTOR,
      fingerprint: setupDraftFingerprint(ROLES),
      now: NOW,
    });
    expect(
      result.ok && result.value !== null && draftRoles(result.value),
    ).toEqual(ROLES);
  });

  it("ignores a stored draft whose fingerprint does not match its roles", async () => {
    const { db } = stubDb(() => ({
      rows: [draftRow({ treasury_role_id: fakeId() })],
    }));
    expect(
      await getSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        fingerprint: setupDraftFingerprint(ROLES),
        now: NOW,
      }),
    ).toEqual({ ok: true, value: null });
  });
});
