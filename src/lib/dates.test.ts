import { describe, expect, it } from "vitest";
import {
  isUsableTimeZone,
  daysBetween,
  instantInZone,
  parseDateInput,
  parseIsoDate,
  todayInZone,
  type DateOnly,
} from "./dates.ts";

const NEW_YORK = "America/New_York";

function date(value: string): DateOnly {
  const result = parseIsoDate(value);
  if (result === null) {
    throw new Error(`Bad date in test: ${value}`);
  }
  return result;
}

function parsed(input: string, today: string, rejectPast = false) {
  return parseDateInput(input, { today: date(today), rejectPast });
}

describe("todayInZone", () => {
  it.each([
    // Spring forward on 2026-03-08: 01:59:59 EST is followed by 03:00:00 EDT.
    ["2026-03-08T04:59:59Z", "2026-03-07"],
    ["2026-03-08T05:00:00Z", "2026-03-08"],
    ["2026-03-08T06:59:59Z", "2026-03-08"],
    ["2026-03-08T07:00:00Z", "2026-03-08"],
    ["2026-03-09T03:59:59Z", "2026-03-08"],
    ["2026-03-09T04:00:00Z", "2026-03-09"],
    // Fall back on 2026-11-01: 01:00 to 01:59 happens twice, EDT and then EST.
    ["2026-11-01T03:59:59Z", "2026-10-31"],
    ["2026-11-01T04:00:00Z", "2026-11-01"],
    ["2026-11-01T05:30:00Z", "2026-11-01"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-11-01T07:00:00Z", "2026-11-01"],
    ["2026-11-02T04:59:59Z", "2026-11-01"],
    ["2026-11-02T05:00:00Z", "2026-11-02"],
  ])("reads %s as %s in New York across DST", (instant, expected) => {
    expect(todayInZone(new Date(instant), NEW_YORK)).toBe(expected);
  });

  it.each([
    ["2026-11-16T03:30:00Z", NEW_YORK, "2026-11-15"],
    ["2026-11-16T03:30:00Z", "UTC", "2026-11-16"],
    ["2026-07-16T03:30:00Z", NEW_YORK, "2026-07-15"],
    ["2026-07-16T04:30:00Z", NEW_YORK, "2026-07-16"],
    ["2027-01-01T04:59:59Z", NEW_YORK, "2026-12-31"],
    ["2027-01-01T05:00:00Z", NEW_YORK, "2027-01-01"],
    ["2027-01-01T04:59:59Z", "UTC", "2027-01-01"],
    ["2028-02-29T04:59:59Z", NEW_YORK, "2028-02-28"],
    ["2028-02-29T05:00:00Z", NEW_YORK, "2028-02-29"],
    ["2028-03-01T04:59:59Z", NEW_YORK, "2028-02-29"],
    ["2026-11-16T03:30:00Z", "Asia/Tokyo", "2026-11-16"],
    ["2026-11-15T14:59:59Z", "Asia/Tokyo", "2026-11-15"],
  ])("reads %s in %s as %s", (instant, zone, expected) => {
    expect(todayInZone(new Date(instant), zone)).toBe(expected);
  });

  it("zero-pads the month and day", () => {
    expect(todayInZone(new Date("2026-01-05T12:00:00Z"), NEW_YORK)).toBe(
      "2026-01-05",
    );
  });

  it("throws a RangeError for an unknown zone or an invalid instant", () => {
    expect(() => todayInZone(new Date(0), "Not/AZone")).toThrow(RangeError);
    expect(() => todayInZone(new Date(Number.NaN), "UTC")).toThrow(RangeError);
  });
});

describe("instantInZone", () => {
  it.each([
    // The fall change was on 2026-11-01 and the spring one on 2026-03-08.
    ["2026-10-31", 17, 30, NEW_YORK, "2026-10-31T21:30:00.000Z"],
    ["2026-11-03", 17, 30, NEW_YORK, "2026-11-03T22:30:00.000Z"],
    ["2026-03-07", 17, 30, NEW_YORK, "2026-03-07T22:30:00.000Z"],
    ["2026-03-10", 17, 30, NEW_YORK, "2026-03-10T21:30:00.000Z"],
    // On the day itself, either side of the change.
    ["2026-11-01", 0, 30, NEW_YORK, "2026-11-01T04:30:00.000Z"],
    ["2026-11-01", 3, 0, NEW_YORK, "2026-11-01T08:00:00.000Z"],
    ["2026-03-08", 1, 30, NEW_YORK, "2026-03-08T06:30:00.000Z"],
    ["2026-03-08", 3, 30, NEW_YORK, "2026-03-08T07:30:00.000Z"],
    // Ahead of UTC, past midnight UTC, and with no daylight saving.
    ["2026-11-03", 7, 0, "Asia/Singapore", "2026-11-02T23:00:00.000Z"],
    ["2026-04-05", 12, 0, "Pacific/Auckland", "2026-04-05T00:00:00.000Z"],
    ["2026-04-04", 12, 0, "Pacific/Auckland", "2026-04-03T23:00:00.000Z"],
    ["2026-11-03", 0, 0, "UTC", "2026-11-03T00:00:00.000Z"],
  ])("reads %s %i:%i in %s as %s", (day, hours, minutes, zone, expected) => {
    expect(
      new Date(instantInZone(date(day), hours, minutes, zone)).toISOString(),
    ).toBe(expected);
  });

  it("refuses a zone the runtime does not know", () => {
    expect(() => instantInZone(date("2026-11-03"), 9, 0, "Mars/Base")).toThrow(
      RangeError,
    );
  });
});

describe("daysBetween", () => {
  it.each([
    ["2026-11-15", "2026-11-15", 0],
    ["2026-11-15", "2026-11-18", 3],
    ["2026-11-18", "2026-11-15", -3],
    // Both DST changes, where the local day is 23 or 25 hours long.
    ["2026-03-07", "2026-03-08", 1],
    ["2026-03-08", "2026-03-09", 1],
    ["2026-03-07", "2026-03-09", 2],
    ["2026-10-31", "2026-11-01", 1],
    ["2026-11-01", "2026-11-02", 1],
    ["2026-01-01", "2026-07-01", 181],
    // Year boundaries.
    ["2026-12-31", "2027-01-01", 1],
    ["2026-12-30", "2027-01-02", 3],
    ["2027-01-01", "2026-12-31", -1],
    ["2026-01-01", "2027-01-01", 365],
    // Leap days.
    ["2028-02-28", "2028-02-29", 1],
    ["2028-02-29", "2028-03-01", 1],
    ["2028-02-28", "2028-03-01", 2],
    ["2027-02-28", "2027-03-01", 1],
    ["2028-01-01", "2029-01-01", 366],
    ["2100-02-28", "2100-03-01", 1],
    ["2000-02-28", "2000-03-01", 2],
    // Years below 100 are not read as 19xx.
    ["0099-12-31", "0100-01-01", 1],
  ])("from %s to %s is %i", (from, to, expected) => {
    expect(daysBetween(date(from), date(to))).toBe(expected);
  });
});

describe("parseIsoDate", () => {
  it.each(["2026-11-15", "2028-02-29", "2000-02-29", "0001-01-01"])(
    "accepts %s",
    (value) => {
      expect(parseIsoDate(value)).toBe(value);
    },
  );

  it.each([
    "2026-02-29",
    "2100-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "2026-01-00",
    "0000-01-01",
    "2026-1-5",
    "26-11-15",
    "2026-11-15T00:00:00Z",
    " 2026-11-15",
    "11/15",
    "",
  ])("rejects %j", (value) => {
    expect(parseIsoDate(value)).toBeNull();
  });
});

describe("parseDateInput", () => {
  describe("with a full date", () => {
    it("returns it unchanged", () => {
      expect(parsed("2026-11-15", "2026-11-04")).toEqual({
        ok: true,
        date: "2026-11-15",
      });
    });

    it("allows a past date unless told otherwise", () => {
      expect(parsed("2026-11-03", "2026-11-04")).toEqual({
        ok: true,
        date: "2026-11-03",
      });
    });

    it("rejects a past date with rejectPast", () => {
      expect(parsed("2026-11-03", "2026-11-04", true)).toEqual({
        ok: false,
        error: "past_date",
      });
      expect(parsed("2025-12-31", "2026-01-01", true)).toEqual({
        ok: false,
        error: "past_date",
      });
    });

    it("treats today and later as not past", () => {
      expect(parsed("2026-11-04", "2026-11-04", true)).toEqual({
        ok: true,
        date: "2026-11-04",
      });
      expect(parsed("2026-11-05", "2026-11-04", true)).toEqual({
        ok: true,
        date: "2026-11-05",
      });
    });
  });

  describe("with a month and day", () => {
    it.each([
      ["11/15", "2026-11-04", "2026-11-15"],
      ["1/5", "2026-11-04", "2027-01-05"],
      ["01/05", "2026-11-04", "2027-01-05"],
      ["  11/15 ", "2026-11-04", "2026-11-15"],
      // Today counts as upcoming, and yesterday means next year.
      ["11/04", "2026-11-04", "2026-11-04"],
      ["11/03", "2026-11-04", "2027-11-03"],
      // Year boundaries.
      ["12/31", "2026-12-31", "2026-12-31"],
      ["12/31", "2027-01-01", "2027-12-31"],
      ["1/1", "2026-12-31", "2027-01-01"],
      ["1/1", "2027-01-01", "2027-01-01"],
      // Feb 29 goes to the next leap year that has it still ahead.
      ["2/29", "2026-11-04", "2028-02-29"],
      ["2/29", "2028-01-15", "2028-02-29"],
      ["2/29", "2028-02-29", "2028-02-29"],
      ["2/29", "2028-03-01", "2032-02-29"],
      ["2/29", "2096-03-01", "2104-02-29"],
      // Feb 28 and Mar 1 around a leap day.
      ["2/28", "2028-02-29", "2029-02-28"],
      ["3/1", "2028-02-29", "2028-03-01"],
    ])("reads %j on %s as %s", (input, today, expected) => {
      expect(parsed(input, today)).toEqual({ ok: true, date: expected });
    });

    it("is never in the past, so rejectPast does not reject it", () => {
      expect(parsed("11/03", "2026-11-04", true)).toEqual({
        ok: true,
        date: "2027-11-03",
      });
    });
  });

  describe("with an unusable today", () => {
    it.each(["garbage", "", "2026-02-30"])(
      "throws a RangeError for %j instead of looping forever",
      (today) => {
        expect(() =>
          parseDateInput("11/15", { today: today as DateOnly }),
        ).toThrow(RangeError);
      },
    );

    it("throws a RangeError when the next occurrence is past the year 9999", () => {
      expect(parsed("12/31", "9999-12-31")).toEqual({
        ok: true,
        date: "9999-12-31",
      });
      expect(() => parsed("1/1", "9999-12-31")).toThrow(RangeError);
      expect(() => parsed("2/29", "9999-03-01")).toThrow(RangeError);
    });
  });

  describe("with an impossible date", () => {
    it.each([
      "2/30",
      "2/31",
      "4/31",
      "6/31",
      "9/31",
      "11/31",
      "1/32",
      "13/1",
      "0/5",
      "5/0",
      "00/00",
      "99/99",
      "2026-02-29",
      "2026-02-30",
      "2100-02-29",
      "2026-13-01",
      "2026-00-01",
      "2026-11-00",
      "2026-11-31",
      "0000-01-01",
    ])("returns invalid_date for %j", (input) => {
      expect(parsed(input, "2026-11-04")).toEqual({
        ok: false,
        error: "invalid_date",
      });
    });

    it("reports an impossible past date as invalid, not past", () => {
      expect(parsed("2020-02-30", "2026-11-04", true)).toEqual({
        ok: false,
        error: "invalid_date",
      });
    });
  });

  describe("with an unrecognised format", () => {
    it.each([
      "",
      "   ",
      "tomorrow",
      "11-15",
      "11/15/2026",
      "2026/11/15",
      "2026-1-5",
      "26-11-15",
      "111/15",
      "11/155",
      "/15",
      "11/",
      "11 / 15",
      "-1/15",
      "2026-11-15T09:00:00Z",
      "١١/١٥",
      "11/15\nextra",
    ])("returns invalid_format for %j", (input) => {
      expect(parsed(input, "2026-11-04")).toEqual({
        ok: false,
        error: "invalid_format",
      });
    });
  });
});

describe("isUsableTimeZone", () => {
  it.each(["America/New_York", "Pacific/Auckland", "UTC"])(
    "accepts %s",
    (zone) => {
      expect(isUsableTimeZone(zone)).toBe(true);
    },
  );

  it.each(["Factory", "factory", "Not/AZone", "", "posix/America/New_York"])(
    "refuses %j",
    (zone) => {
      expect(isUsableTimeZone(zone)).toBe(false);
    },
  );
});
