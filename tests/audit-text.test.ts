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
