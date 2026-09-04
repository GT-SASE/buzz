import { describe, expect, it } from "vitest";

import {
  COMMITTEE_CYCLE_CLOSES_AT,
  committeeAnswerFields,
  committeeApplySchema,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
} from "../packages/api/src/committee-cycle";

describe("isCommitteeCycleOpen", () => {
  it("is open the morning of the close date in Atlanta", () => {
    expect(isCommitteeCycleOpen(new Date("2026-09-09T15:00:00.000Z"))).toBe(
      true,
    );
  });

  it("closes at the instant Thursday starts in Atlanta", () => {
    expect(isCommitteeCycleOpen(COMMITTEE_CYCLE_CLOSES_AT)).toBe(false);
    expect(
      isCommitteeCycleOpen(new Date(COMMITTEE_CYCLE_CLOSES_AT.getTime() - 1)),
    ).toBe(true);
  });
});

describe("isCommitteeApplicationLocked", () => {
  it("locks once an officer has taken the row out of the inbox", () => {
    expect(isCommitteeApplicationLocked("submitted")).toBe(false);
    expect(isCommitteeApplicationLocked("withdrawn")).toBe(false);
    expect(isCommitteeApplicationLocked("interviewing")).toBe(true);
    expect(isCommitteeApplicationLocked("accepted")).toBe(true);
    expect(isCommitteeApplicationLocked("declined")).toBe(true);
  });
});

describe("committeeApplySchema", () => {
  const base = {
    discordHandle: "samanyu",
    wantsEvents: false,
    wantsMarketing: false,
    wantsTreasury: true,
    treasuryWhy: "I want to learn the SGA bills process.",
  };

  it("accepts a treasury-only application", () => {
    const parsed = committeeApplySchema.parse(base);
    expect(parsed.wantsTreasury).toBe(true);
    expect(committeeAnswerFields(parsed).eventsWhy).toBeNull();
  });

  it("refuses an application with no committee", () => {
    const result = committeeApplySchema.safeParse({
      ...base,
      wantsTreasury: false,
      treasuryWhy: undefined,
    });
    expect(result.success).toBe(false);
  });

  it("requires a why for each selected committee", () => {
    const result = committeeApplySchema.safeParse({
      ...base,
      wantsEvents: true,
    });
    expect(result.success).toBe(false);
  });

  it("drops answers for committees they did not pick", () => {
    const parsed = committeeApplySchema.parse({
      ...base,
      eventsWhy: "should not stick",
    });
    expect(committeeAnswerFields(parsed).eventsWhy).toBeNull();
    expect(committeeAnswerFields(parsed).treasuryWhy).toContain("SGA");
  });
});
