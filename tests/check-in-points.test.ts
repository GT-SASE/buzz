import { describe, expect, it } from "vitest";

import { pointsForArrival } from "../packages/api/src/check-in-points";

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
