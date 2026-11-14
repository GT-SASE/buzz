/**
 * What the event workflow functions refuse before any query, and how they read the
 * answers. test/db covers what the database does with them.
 */

import { describe, expect, it } from "bun:test";
import { fakeId } from "../../test/support/ids.ts";
import { serverError } from "../../test/support/sql-client.ts";
import { stubDb } from "../../test/support/stub-db.ts";
import {
  assignEventStep,
  getEventWorkflow,
  setEventPickupTime,
} from "./event-steps.ts";
import {
  getSetupDraft,
  setupDraftFingerprint,
  type SetupRoles,
} from "./guild-config.ts";

const GUILD = fakeId();
const ACTOR = fakeId();
const USER = fakeId();
const ID = "11111111-2222-4333-8444-555555555555";
const CREATED = "2030-01-01T11:00:00.123456+00:00";

const assignment = {
  guildId: GUILD,
  eventId: ID,
  kind: "budget_sheet" as const,
  userId: USER,
  actorId: ACTOR,
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

describe("the event workflow functions", () => {
  it.each(["5:30", "24:00", "17:30:00"])(
    "refuses the pickup time %j before any query",
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

  it("orders a workflow's steps by kind, and gives the time as HH:MM", async () => {
    const { db } = stubDb(() => ({
      rows: [
        {
          id: ID,
          pickup_time: "17:30:00",
          steps: [
            step("food_pickup"),
            step("budget_approved", "done"),
            step("engage_post"),
            step("budget_sheet", "done"),
          ],
          assignees: [],
        },
      ],
    }));
    const result = await getEventWorkflow(db, { guildId: GUILD, eventId: ID });
    const workflow = result.ok ? result.value : null;
    expect(workflow?.pickup_time).toBe("17:30");
    expect(workflow?.steps.map((row) => [row.kind, row.status])).toEqual([
      ["budget_sheet", "done"],
      ["engage_post", "open"],
      ["budget_approved", "done"],
      ["food_pickup", "open"],
    ]);
  });

  it.each([
    [{ rows: [{ value: null }] }, { category: "not_found", code: null }],
    [serverError("CF431"), { category: "step_assignee_limit", code: "CF431" }],
    [serverError("CF410"), { category: "parent_unavailable", code: "CF410" }],
  ])("reports %j as %j", async (answer, error) => {
    const { db } = stubDb(() => answer);
    const result: unknown = await assignEventStep(db, assignment);
    expect(result).toEqual({
      ok: false,
      error,
    });
  });
});

describe("setup drafts", () => {
  const ROLES: SetupRoles = {
    officerRoleId: fakeId(),
    adminRoleId: fakeId(),
    eboardRoleId: fakeId(),
    eventsCommitteeRoleId: fakeId(),
    treasuryRoleId: fakeId(),
    marketingRoleId: fakeId(),
  };

  it("fingerprints the six roles in order, in a short custom_id-safe form", () => {
    const fingerprint = setupDraftFingerprint(ROLES);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(
      setupDraftFingerprint({
        ...ROLES,
        treasuryRoleId: ROLES.marketingRoleId,
        marketingRoleId: ROLES.treasuryRoleId,
      }),
    ).not.toBe(fingerprint);
  });

  it("ignores a stored draft whose fingerprint does not match its roles", async () => {
    const { db } = stubDb(() => ({
      rows: [
        {
          guild_id: GUILD,
          actor_id: ACTOR,
          officer_role_id: ROLES.officerRoleId,
          admin_role_id: ROLES.adminRoleId,
          eboard_role_id: ROLES.eboardRoleId,
          events_committee_role_id: ROLES.eventsCommitteeRoleId,
          treasury_role_id: fakeId(),
          marketing_role_id: ROLES.marketingRoleId,
          fingerprint: setupDraftFingerprint(ROLES),
          created_at: CREATED,
        },
      ],
    }));
    expect(
      await getSetupDraft(db, {
        guildId: GUILD,
        actorId: ACTOR,
        fingerprint: setupDraftFingerprint(ROLES),
        now: new Date("2030-01-01T12:00:00.000Z"),
      }),
    ).toEqual({ ok: true, value: null });
  });
});
