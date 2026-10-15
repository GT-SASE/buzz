import { describe, expect, it } from "vitest";

import {
  catchUpBonus,
  medianOf,
  pointsForArrival,
  scoreCheckIn,
  streakBonus,
  streakLevel,
  STREAK_CAP,
  type CheckInScoreInput,
} from "../packages/api/src/check-in-points";

describe("pointsForArrival", () => {
  it("pays a declining bonus to the first five, then the event value", () => {
    expect(pointsForArrival(15, 0)).toBe(20);
    expect(pointsForArrival(15, 1)).toBe(19);
    expect(pointsForArrival(15, 4)).toBe(16);
    expect(pointsForArrival(15, 5)).toBe(15);
    expect(pointsForArrival(15, 40)).toBe(15);
  });

  it("does not spice a zero-point listing", () => {
    expect(pointsForArrival(0, 0)).toBe(0);
    expect(pointsForArrival(0, 2)).toBe(0);
  });
});

describe("streakBonus", () => {
  it("pays +2 per level, capped at 10", () => {
    expect(STREAK_CAP).toBe(10);
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(1)).toBe(2);
    expect(streakBonus(2)).toBe(4);
    expect(streakBonus(5)).toBe(10);
    expect(streakBonus(8)).toBe(10);
    expect(streakBonus(-1)).toBe(0);
  });
});

describe("streakLevel", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];

  it("is 0 with no history or no attendance", () => {
    expect(streakLevel([], [])).toBe(0);
    expect(streakLevel([], ids)).toBe(0);
  });

  it("ignores history before the first attended happening", () => {
    expect(streakLevel(["c"], ids.slice(0, 3))).toBe(1);
    expect(streakLevel(["c", "d"], ids.slice(0, 4))).toBe(2);
  });

  it("gives n in a row min(5, n) levels, so min(10, 2n) points", () => {
    const run = Array.from({ length: 8 }, (_, i) => `e${i}`);
    for (let n = 1; n <= 8; n += 1) {
      const level = streakLevel(run.slice(0, n), run.slice(0, n));
      expect(level).toBe(Math.min(5, n));
      expect(streakBonus(level)).toBe(Math.min(10, 2 * n));
    }
  });

  it("drops one level per miss", () => {
    const attended = ["a", "b", "c"];
    expect(streakBonus(streakLevel(attended, ["a", "b", "c", "d"]))).toBe(4);
    expect(streakBonus(streakLevel(attended, ["a", "b", "c", "d", "e"]))).toBe(
      2,
    );
  });

  it("never goes below 0 and can climb back", () => {
    expect(streakLevel(["a"], ["a", "b", "c", "d"])).toBe(0);
    expect(streakLevel(["a", "e"], ["a", "b", "c", "d", "e"])).toBe(1);
    expect(streakLevel(["a", "b", "c", "e"], ids.slice(0, 5))).toBe(3);
    expect(streakLevel(["a", "b", "c", "d", "f"], ids)).toBe(4);
  });

  it("ignores attended ids that are not live happenings (archived)", () => {
    // "x" was archived upstream: absent from happenings, so neither a hit nor a miss.
    expect(streakLevel(["a", "x", "c"], ["a", "c"])).toBe(2);
    expect(streakLevel(["x"], ["a", "b"])).toBe(0);
  });
});

describe("medianOf", () => {
  it("is null when empty, the middle when odd, the mean of the middle two when even", () => {
    expect(medianOf([])).toBeNull();
    expect(medianOf([9, 1, 5])).toBe(5);
    expect(medianOf([10, 2, 4, 8])).toBe(6);
    expect(medianOf([1, 2])).toBe(1.5);
  });
});

describe("catchUpBonus", () => {
  it("gives half the gap to the median, rounded up", () => {
    expect(catchUpBonus(10, 0, 8)).toBe(4);
    expect(catchUpBonus(10, 0, 7)).toBe(4);
    expect(catchUpBonus(10, 6, 7)).toBe(1);
    expect(catchUpBonus(10, 0, 1.5)).toBe(1);
  });

  it("never exceeds the event value", () => {
    expect(catchUpBonus(10, 0, 100)).toBe(10);
    expect(catchUpBonus(3, 0, 100)).toBe(3);
  });

  it("is 0 at or above the median, or with nobody to compare to", () => {
    expect(catchUpBonus(10, 20, 20)).toBe(0);
    expect(catchUpBonus(10, 30, 20)).toBe(0);
    expect(catchUpBonus(10, 0, null)).toBe(0);
  });
});

describe("scoreCheckIn", () => {
  const member: CheckInScoreInput = {
    base: 10,
    isOfficer: false,
    priorMemberArrivals: 9,
    streakLevel: 0,
    ownTotal: 0,
    medianTotal: null,
  };

  it("pays an officer the base and ignores every bonus input", () => {
    expect(
      scoreCheckIn({
        ...member,
        isOfficer: true,
        priorMemberArrivals: 0,
        streakLevel: 5,
        ownTotal: 0,
        medianTotal: 100,
      }),
    ).toBe(10);
  });

  it("pays a member the base alone with no bonus in play", () => {
    expect(scoreCheckIn(member)).toBe(10);
  });

  it("adds the early-bird by member arrival order", () => {
    const pay = (prior: number) =>
      scoreCheckIn({ ...member, priorMemberArrivals: prior });
    expect([0, 1, 2, 3, 4, 5].map(pay)).toEqual([15, 14, 13, 12, 11, 10]);
  });

  it("adds the streak, capped at +10", () => {
    const pay = (level: number) =>
      scoreCheckIn({ ...member, streakLevel: level });
    expect([0, 1, 2, 5, 9].map(pay)).toEqual([10, 12, 14, 20, 20]);
  });

  it("adds catch-up for a member under the median", () => {
    expect(scoreCheckIn({ ...member, ownTotal: 0, medianTotal: 9 })).toBe(15);
    expect(scoreCheckIn({ ...member, ownTotal: 0, medianTotal: 500 })).toBe(20);
    expect(scoreCheckIn({ ...member, ownTotal: 9, medianTotal: 9 })).toBe(10);
  });

  it("stacks early-bird, streak and catch-up", () => {
    expect(
      scoreCheckIn({
        ...member,
        priorMemberArrivals: 0,
        streakLevel: 2,
        ownTotal: 0,
        medianTotal: 6,
      }),
    ).toBe(10 + 5 + 4 + 3);
  });

  it("pays nothing for a zero-point listing, officer or not", () => {
    expect(
      scoreCheckIn({
        ...member,
        base: 0,
        priorMemberArrivals: 0,
        streakLevel: 3,
        medianTotal: 50,
      }),
    ).toBe(0);
    expect(scoreCheckIn({ ...member, base: 0, isOfficer: true })).toBe(0);
  });
});
