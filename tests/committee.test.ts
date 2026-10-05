import { describe, expect, it } from "vitest";

import {
  committeeAnswerFields,
  committeeApplySchema,
  committeeIdsSchema,
  closedCommitteePicks,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
} from "../packages/api/src/committee-cycle";

describe("isCommitteeCycleOpen", () => {
  const closesAt = new Date("2026-09-10T04:00:00.000Z");

  it("is open before the close instant", () => {
    expect(
      isCommitteeCycleOpen(closesAt, new Date("2026-09-09T15:00:00.000Z")),
    ).toBe(true);
    expect(
      isCommitteeCycleOpen(closesAt, new Date(closesAt.getTime() - 1)),
    ).toBe(true);
  });

  it("closes at the close instant, exclusive", () => {
    expect(isCommitteeCycleOpen(closesAt, closesAt)).toBe(false);
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

describe("closedCommitteePicks", () => {
  const picks = {
    wantsEvents: true,
    wantsMarketing: false,
    wantsTreasury: false,
    wantsWebsite: true,
  };

  it("flags picks the cycle is not taking", () => {
    expect(closedCommitteePicks(picks, ["website"])).toEqual(["events"]);
    expect(closedCommitteePicks(picks, ["events", "website"])).toEqual([]);
  });

  it("keeps a pick the member already saved", () => {
    expect(
      closedCommitteePicks(picks, ["website"], { wantsEvents: true }),
    ).toEqual([]);
  });
});

describe("committeeIdsSchema", () => {
  it("dedupes into canonical order", () => {
    expect(committeeIdsSchema.parse(["website", "events", "website"])).toEqual([
      "events",
      "website",
    ]);
  });

  it("needs at least one known committee", () => {
    expect(committeeIdsSchema.safeParse([]).success).toBe(false);
    expect(committeeIdsSchema.safeParse(["finance"]).success).toBe(false);
  });
});
