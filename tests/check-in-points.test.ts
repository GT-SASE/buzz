import { describe, expect, it } from "vitest";

import {
  consecutivePriorStreak,
  pointsForArrival,
  pointsForCheckIn,
  streakBonus,
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
  it("pays +3 per prior consecutive happening, capped at 9", () => {
    expect(streakBonus(0)).toBe(0);
    expect(streakBonus(1)).toBe(3);
    expect(streakBonus(2)).toBe(6);
    expect(streakBonus(3)).toBe(9);
    expect(streakBonus(8)).toBe(9);
  });
});

describe("consecutivePriorStreak", () => {
  it("counts newest-first until a miss", () => {
    expect(consecutivePriorStreak(["a", "b"], ["b", "a"])).toBe(2);
    expect(consecutivePriorStreak(["b"], ["b", "a"])).toBe(1);
    expect(consecutivePriorStreak(["a"], ["b", "a"])).toBe(0);
    expect(consecutivePriorStreak(["a", "c"], ["b", "a"])).toBe(0);
  });
});

describe("pointsForCheckIn", () => {
  it("adds the streak on top of early-bird, and still zeros a free listing", () => {
    expect(pointsForCheckIn(15, 0, 0)).toBe(20);
    expect(pointsForCheckIn(15, 5, 1)).toBe(18);
    expect(pointsForCheckIn(0, 0, 4)).toBe(0);
  });
});
