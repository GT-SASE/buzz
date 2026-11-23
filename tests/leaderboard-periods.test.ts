import { describe, expect, it } from "bun:test";

import {
  leaderboardWindow,
  schoolYearWindow,
  semesterWindow,
} from "../packages/api/src/periods";
import { previousSemester } from "../packages/api/src/terms";

const iso = (window: { from: Date; to: Date }) => [
  window.from.toISOString(),
  window.to.toISOString(),
];

describe("semester and school-year windows", () => {
  it("holds fall from August 1st to January 1st, Atlanta time", () => {
    // Midnight Aug 1 is UTC-4 (EDT); midnight Jan 1 is UTC-5 (EST).
    const expected = ["2026-08-01T04:00:00.000Z", "2027-01-01T05:00:00.000Z"];
    expect(iso(semesterWindow(new Date("2026-11-23T12:00:00Z")))).toEqual(
      expected,
    );
    expect(iso(semesterWindow(new Date("2026-08-01T04:00:00Z")))).toEqual(
      expected,
    );
    // 23:59 on December 31st in Atlanta is already January 1st in UTC.
    expect(iso(semesterWindow(new Date("2027-01-01T04:59:00Z")))).toEqual(
      expected,
    );
  });

  it("starts spring at the first Atlanta midnight of January, summer included", () => {
    const expected = ["2027-01-01T05:00:00.000Z", "2027-08-01T04:00:00.000Z"];
    expect(iso(semesterWindow(new Date("2027-01-01T05:00:00Z")))).toEqual(
      expected,
    );
    expect(iso(semesterWindow(new Date("2027-06-15T12:00:00Z")))).toEqual(
      expected,
    );
    // 23:59 on July 31st in Atlanta is still spring.
    expect(iso(semesterWindow(new Date("2027-08-01T03:59:00Z")))).toEqual(
      expected,
    );
  });

  it("holds a school year from August 1st to the next August 1st", () => {
    const expected = ["2026-08-01T04:00:00.000Z", "2027-08-01T04:00:00.000Z"];
    expect(iso(schoolYearWindow(new Date("2026-08-01T04:00:00Z")))).toEqual(
      expected,
    );
    expect(iso(schoolYearWindow(new Date("2027-03-01T12:00:00Z")))).toEqual(
      expected,
    );
    expect(iso(schoolYearWindow(new Date("2027-08-01T03:59:00Z")))).toEqual(
      expected,
    );
    expect(iso(schoolYearWindow(new Date("2027-08-01T04:00:00Z")))).toEqual([
      "2027-08-01T04:00:00.000Z",
      "2028-08-01T04:00:00.000Z",
    ]);
  });

  it("has no bounds for all time", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    expect(leaderboardWindow("all", now)).toBeNull();
    expect(leaderboardWindow("semester", now)).toEqual(semesterWindow(now));
    expect(leaderboardWindow("year", now)).toEqual(schoolYearWindow(now));
  });

  it("names the semester before one", () => {
    expect(previousSemester("spring-2027")).toBe("fall-2026");
    expect(previousSemester("fall-2027")).toBe("spring-2027");
  });
});
