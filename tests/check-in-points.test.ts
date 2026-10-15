import { describe, expect, it } from "vitest";

import {
  pointsForArrival,
  pointsForCheckIn,
  streakBonus,
  streakLevel,
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
  it("pays +3 per level, capped at 9", () => {
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(1)).toBe(3);
    expect(streakBonus(2)).toBe(6);
    expect(streakBonus(3)).toBe(9);
    expect(streakBonus(8)).toBe(9);
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

  it("gives n in a row min(3, n) levels, so min(9, 3n) points", () => {
    for (let n = 1; n <= 6; n += 1) {
      const level = streakLevel(ids.slice(0, n), ids.slice(0, n));
      expect(level).toBe(Math.min(3, n));
      expect(streakBonus(level)).toBe(Math.min(9, 3 * n));
    }
  });

  it("drops one level per miss", () => {
    const attended = ["a", "b", "c"];
    expect(streakBonus(streakLevel(attended, ["a", "b", "c", "d"]))).toBe(6);
    expect(streakBonus(streakLevel(attended, ["a", "b", "c", "d", "e"]))).toBe(
      3,
    );
  });

  it("never goes below 0 and can climb back", () => {
    expect(streakLevel(["a"], ["a", "b", "c", "d"])).toBe(0);
    expect(streakLevel(["a", "e"], ["a", "b", "c", "d", "e"])).toBe(1);
    expect(streakLevel(["a", "b", "c", "e"], ids.slice(0, 5))).toBe(3);
  });

  it("ignores attended ids that are not live happenings (archived)", () => {
    // "x" was archived upstream: absent from happenings, so neither a hit nor a miss.
    expect(streakLevel(["a", "x", "c"], ["a", "c"])).toBe(2);
    expect(streakLevel(["x"], ["a", "b"])).toBe(0);
  });
});

describe("pointsForCheckIn", () => {
  it("adds the streak on top of early-bird, and still zeros a free listing", () => {
    expect(pointsForCheckIn(15, 0, 0)).toBe(20);
    expect(pointsForCheckIn(15, 5, 1)).toBe(18);
    expect(pointsForCheckIn(0, 0, 3)).toBe(0);
  });
});
