import { describe, expect, it } from "bun:test";

import { AUDIT_ACTIONS, POINTS_SOURCES } from "../packages/db/src/schema";
import {
  actionLabels,
  actionNames,
  dateRange,
  describeChange,
  describeTarget,
  sourceLabels,
  sourceNames,
} from "../sites/web/src/app/portal/(member)/admin/audit/audit-text";

describe("audit page vocabulary", () => {
  it("labels every action and every source, in the order the schema lists them", () => {
    expect(actionNames).toEqual([...AUDIT_ACTIONS]);
    expect(sourceNames).toEqual([...POINTS_SOURCES]);
    for (const name of actionNames) expect(actionLabels[name]).toBeTruthy();
    for (const name of sourceNames) expect(sourceLabels[name]).toBeTruthy();
  });
});

describe("describeChange", () => {
  it("says what moved for every action", () => {
    const cases: [(typeof AUDIT_ACTIONS)[number], object, object, string][] = [
      [
        "member.set_role",
        { role: "MEMBER" },
        { role: "ADMIN" },
        "Member to Officer",
      ],
      [
        "member.set_graduation_year",
        { graduationYear: null },
        { graduationYear: 2028 },
        "unset to 2028",
      ],
      [
        "committee.set_status",
        { status: "submitted", cycle: "fall-2026" },
        { status: "accepted", cycle: "fall-2026" },
        "submitted to accepted, fall-2026",
      ],
      [
        "event.manual_check_in",
        {},
        { event: "GBM 3", points: 10 },
        "GBM 3, +10 points",
      ],
      [
        "event.remove_check_in",
        { event: "GBM 3", points: 10 },
        {},
        "GBM 3, -10 points",
      ],
      [
        "event.create",
        {},
        { startsAt: "2026-11-24T23:00:00.000Z", points: 10, seats: 40 },
        "2026-11-24 23:00 UTC, 10 points, 40 seats",
      ],
      [
        "event.create_series",
        {},
        {
          startsAt: "2026-11-24T23:00:00.000Z",
          cadence: "weekly",
          occurrences: 8,
          lastStartsAt: "2027-01-12T23:00:00.000Z",
        },
        "8 weekly events from 2026-11-24 23:00 UTC to 2027-01-12 23:00 UTC",
      ],
      [
        "event.update",
        { location: "Klaus 1116", seats: 40 },
        { location: "CULC 144", seats: 60 },
        "location Klaus 1116 to CULC 144, seats 40 to 60",
      ],
      [
        "event.update_series",
        { title: "GBM" },
        { title: "Weekly GBM", occurrences: 6 },
        "title GBM to Weekly GBM, 6 events",
      ],
      ["event.archive", {}, { archived: true }, "Archived"],
      [
        "event.archive_series",
        {},
        { archived: false, occurrences: 5 },
        "Restored, 5 events",
      ],
      ["event.set_check_in", {}, { checkInEnabled: true }, "Opened check-in"],
      ["event.revoke_codes", {}, {}, "Every outstanding code stopped working"],
      [
        "mentorship.award_points",
        { points: 12 },
        { points: 17 },
        "12 to 17 points",
      ],
      [
        "mentorship.award_group_points",
        {},
        { points: 3, members: 6 },
        "+3 points each to 6 members",
      ],
      [
        "kin_group.carry_forward",
        {},
        { from: "spring-2027", to: "fall-2027", created: 3, skipped: 1 },
        "spring-2027 to fall-2027, 3 new, 1 already there",
      ],
      [
        "election.create",
        {},
        {
          positions: 4,
          opensAt: "2027-03-01T14:00:00.000Z",
          closesAt: null,
          minCheckIns: 2,
        },
        "4 positions, opens 2027-03-01 14:00 UTC, closes unset, 2+ check-ins",
      ],
      [
        "election.configure",
        { opensAt: null, closesAt: null, minCheckIns: 1 },
        {
          opensAt: "2027-03-01T14:00:00.000Z",
          closesAt: "2027-03-05T14:00:00.000Z",
          minCheckIns: 3,
        },
        "opens unset, closes unset, 1+ check-ins to opens 2027-03-01 14:00 UTC, closes 2027-03-05 14:00 UTC, 3+ check-ins",
      ],
      [
        "election.set_phase",
        { phase: "nominating" },
        { phase: "voting", scheduled: true, voters: 41 },
        "nominating to voting by schedule, 41 voters frozen",
      ],
      [
        "election.edit_positions",
        {},
        { added: "Treasurer" },
        "Added Treasurer",
      ],
      [
        "election.review_candidate",
        { status: "pending" },
        { status: "approved", candidate: "Ada" },
        "Ada: pending to approved",
      ],
      ["election.delete", {}, {}, "Deleted"],
      ["export.election_tally", {}, { rows: 9, truncated: false }, "9 rows"],
      ["board.remove_photo", { photo: true }, {}, "Headshot taken down"],
      [
        "export.roster",
        {},
        { rows: 120, truncated: false, search: "ada" },
        '120 rows, search "ada"',
      ],
      [
        "export.attendance",
        {},
        { rows: 1, truncated: true },
        "1 row, cut off at the limit",
      ],
      ["export.committee", {}, { rows: 0, truncated: false }, "0 rows"],
      ["resume.download", {}, { fileName: "ada.pdf", bytes: 10 }, "ada.pdf"],
    ];

    for (const [action, before, after, expected] of cases) {
      expect(
        describeChange({
          action,
          before: before as Record<string, unknown>,
          after: after as Record<string, unknown>,
        }),
      ).toBe(expected);
    }
    // Every action is covered above.
    expect(cases.map(([action]) => action)).toEqual([...AUDIT_ACTIONS]);
  });

  it("does not throw on a row with no detail", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(() =>
        describeChange({ action, before: null, after: null }),
      ).not.toThrow();
    }
  });
});

describe("describeTarget", () => {
  const row = {
    targetType: "member",
    targetName: null,
    targetEmail: null,
    targetLabel: null,
    targetId: null,
  };

  it("prefers the member as they are named today, then the label kept at the time", () => {
    expect(
      describeTarget({ ...row, targetName: "Ada", targetLabel: "old@x.edu" }),
    ).toBe("Ada");
    expect(
      describeTarget({ ...row, targetEmail: "ada@x.edu", targetLabel: "old" }),
    ).toBe("ada@x.edu");
    expect(describeTarget({ ...row, targetLabel: "gone@x.edu" })).toBe(
      "gone@x.edu",
    );
    expect(describeTarget({ ...row, targetId: "user-1" })).toBe("user-1");
  });

  it("names the roster", () => {
    expect(describeTarget({ ...row, targetType: "roster" })).toBe(
      "Whole roster",
    );
  });
});

describe("dateRange", () => {
  it("is empty when no date is picked", () => {
    expect(dateRange("", "")).toEqual({ from: undefined, to: undefined });
  });

  it("makes one picked day the whole of that day in Atlanta time", () => {
    const { from, to } = dateRange("2026-11-20", "2026-11-20");
    expect(from?.toISOString()).toBe("2026-11-20T05:00:00.000Z");
    expect(to?.toISOString()).toBe("2026-11-21T05:00:00.000Z");
  });

  it("follows the clock change instead of adding 24 hours", () => {
    const { from, to } = dateRange("2026-03-08", "2026-03-08");
    expect(from?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(to?.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("takes either end alone", () => {
    expect(dateRange("2026-11-20", "").to).toBeUndefined();
    expect(dateRange("", "2026-11-20").from).toBeUndefined();
  });
});
