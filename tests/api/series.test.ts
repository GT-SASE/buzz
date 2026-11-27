import { describe, expect, it } from "bun:test";

import {
  addLocalDays,
  CHAPTER_ZONE,
  MAX_OCCURRENCES,
  occurrenceStarts,
  shiftLike,
  toLocal,
} from "../../packages/api/src/series";

/** The hour on the Atlanta clock. */
const hourInAtlanta = (date: Date) => toLocal(date).hour;

describe("recurring event dates", () => {
  // 7 pm Atlanta on Wed 28 Oct 2026, a few days before the clocks go back.
  const first = new Date("2026-10-28T23:00:00.000Z");

  it("uses the Atlanta zone", () => {
    expect(CHAPTER_ZONE).toBe("America/New_York");
    expect(hourInAtlanta(first)).toBe(19);
  });

  it("repeats weekly at the same wall-clock time across a clock change", () => {
    const starts = occurrenceStarts(first, "weekly", { count: 4 });
    expect(starts).toHaveLength(4);
    expect(starts[0]!.getTime()).toBe(first.getTime());
    // 4 Nov is after DST ended on 1 Nov: 7 pm is now 00:00 UTC the next day.
    expect(starts[1]!.toISOString()).toBe("2026-11-05T00:00:00.000Z");
    expect(starts.map(hourInAtlanta)).toEqual([19, 19, 19, 19]);
    // Never a fixed 7 x 24 hours.
    expect(starts[1]!.getTime() - starts[0]!.getTime()).toBe(
      7 * 24 * 3600_000 + 3600_000,
    );
  });

  it("repeats every two weeks", () => {
    const starts = occurrenceStarts(first, "biweekly", { count: 3 });
    expect(starts.map((d) => toLocal(d).day)).toEqual([28, 11, 25]);
    expect(starts.map(hourInAtlanta)).toEqual([19, 19, 19]);
  });

  it("stops at an end date, counting it as inclusive", () => {
    const until = new Date("2026-11-18T23:00:00.000Z");
    const starts = occurrenceStarts(first, "weekly", { until });
    // 28 Oct, 4 Nov, 11 Nov, 18 Nov (7 pm Atlanta is 00:00Z the next day).
    expect(starts).toHaveLength(3);
    const lastDay = occurrenceStarts(first, "weekly", {
      until: new Date("2026-11-19T01:00:00.000Z"),
    });
    expect(lastDay).toHaveLength(4);
  });

  it("is bounded however far the end date is", () => {
    const far = new Date("2036-01-01T00:00:00.000Z");
    expect(occurrenceStarts(first, "weekly", { until: far })).toHaveLength(
      MAX_OCCURRENCES,
    );
    expect(occurrenceStarts(first, "weekly", { count: 500 })).toHaveLength(
      MAX_OCCURRENCES,
    );
  });

  it("keeps a late-night start on its own calendar day", () => {
    // 11:30 pm Atlanta.
    const late = new Date("2026-11-04T04:30:00.000Z");
    expect(toLocal(late).day).toBe(3);
    const next = addLocalDays(late, 7);
    expect(toLocal(next)).toMatchObject({ day: 10, hour: 23, minute: 30 });
  });

  it("shifts a later occurrence by the same days and time of day as the edit", () => {
    const before = new Date("2026-10-28T23:00:00.000Z"); // Wed 7 pm
    const after = new Date("2026-10-29T22:30:00.000Z"); // Thu 6:30 pm
    const target = new Date("2026-11-12T00:00:00.000Z"); // Wed 11 Nov 7 pm
    const moved = shiftLike(target, before, after);
    expect(toLocal(moved)).toMatchObject({
      month: 11,
      day: 12,
      hour: 18,
      minute: 30,
    });
  });
});
