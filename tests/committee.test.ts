import { describe, expect, it } from "bun:test";

import {
  committeeAnswerFields,
  committeeApplySchema,
  committeeIdsSchema,
  closedCommitteePicks,
  currentCommitteeCycle,
  isCommitteeApplicationLocked,
  isCommitteeCycleOpen,
} from "../packages/api/src/committee-cycle";
import { nextSemester } from "../packages/api/src/terms";

describe("currentCommitteeCycle", () => {
  const fall = {
    id: "fall-2026",
    createdAt: new Date("2026-08-15T16:00:00.000Z"),
    closesAt: new Date("2026-09-10T04:00:00.000Z"),
  };
  // Opened on December 20 for spring: the id is spring even though the clock
  // still reads fall that day.
  const spring = {
    id: "spring-2027",
    createdAt: new Date("2026-12-20T17:00:00.000Z"),
    closesAt: new Date("2027-01-31T05:00:00.000Z"),
  };

  it("finds a spring cycle opened in December on both sides of January 1", () => {
    expect(
      currentCommitteeCycle([fall, spring], new Date("2026-12-21T17:00:00Z")),
    ).toBe(spring);
    expect(
      currentCommitteeCycle([fall, spring], new Date("2027-01-02T17:00:00Z")),
    ).toBe(spring);
  });

  it("prefers the newest cycle when two are open", () => {
    const lateFall = { ...fall, closesAt: new Date("2027-01-15T05:00:00Z") };
    expect(
      currentCommitteeCycle(
        [lateFall, spring],
        new Date("2026-12-21T17:00:00Z"),
      ),
    ).toBe(spring);
  });

  it("falls back to this semester's closed cycle, then to none", () => {
    expect(
      currentCommitteeCycle([fall, spring], new Date("2026-10-01T12:00:00Z")),
    ).toBe(fall);
    expect(
      currentCommitteeCycle([fall], new Date("2027-02-01T12:00:00Z")),
    ).toBeNull();
  });
});

describe("nextSemester", () => {
  it("alternates fall and spring, rolling the year after fall", () => {
    expect(nextSemester("fall-2026")).toBe("spring-2027");
    expect(nextSemester("spring-2027")).toBe("fall-2027");
  });
});

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
