import { afterAll, describe, expect, it } from "vitest";

/**
 * The module is imported *after* the process time zone is moved off Atlanta,
 * and that ordering is the point of this file.
 *
 * `format.ts` builds its `Intl.DateTimeFormat` instances at module scope, so a
 * dropped `timeZone: ZONE` bakes the machine's zone into them the moment the
 * module is first evaluated. A developer laptop, and this repo's CI, both
 * happen to sit in America/New_York — every assertion below would pass on a
 * broken build there. Pinning the process to UTC+14 (a zone that is on a
 * different calendar day from Atlanta for ten hours out of every twenty-four)
 * makes an unpinned formatter fail loudly instead.
 *
 * Static `import` is hoisted above assignment, hence the dynamic one.
 */
const machineZone = process.env.TZ;
process.env.TZ = "Pacific/Kiritimati";

const {
  formatDate,
  formatEventTime,
  formatMonth,
  fromLocalInputValue,
  toLocalInputValue,
} = await import("~/app/portal/_lib/format");

afterAll(() => {
  if (machineZone === undefined) delete process.env.TZ;
  else process.env.TZ = machineZone;
});

/**
 * ICU 72 changed the separator before AM/PM from a plain space to U+202F. The
 * wall clock is the invariant here, not the byte used to space it, so the
 * assertions compare on normalised whitespace.
 */
const spaces = (value: string) => value.replace(/[\u202f\u00a0]/g, " ");

/** The zone's offset from UTC at the instant a wall clock resolves to. */
const offsetHours = (wall: string) =>
  (Date.parse(`${wall}:00Z`) - fromLocalInputValue(wall).getTime()) / 3_600_000;

describe("the fixture itself", () => {
  /**
   * Every "not the UTC day" assertion below is only a real guard while the
   * process is somewhere other than Atlanta. Node's runtime `TZ` reassignment
   * is what makes that true, and it is not specified behaviour — if a future
   * runtime ignores it, this file would keep passing while testing nothing.
   * Better to be told.
   */
  it("runs with the process zone off Atlanta", () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "Pacific/Kiritimati",
    );
  });
});

describe("toLocalInputValue", () => {
  /**
   * The anchor. 22:00 UTC on 28 August 2026 is 6:00 PM in Atlanta, and nowhere
   * else. If the formatter ever loses its `timeZone`, this is the assertion
   * that says so rather than quietly agreeing with whatever the host is set to.
   */
  it("renders a known instant as the Atlanta wall clock", () => {
    expect(toLocalInputValue(new Date("2026-08-28T22:00:00Z"))).toBe(
      "2026-08-28T18:00",
    );
  });

  it("uses the Atlanta calendar day, not the UTC one", () => {
    // 2:00 UTC on the 29th is still the evening of the 28th in Atlanta. An
    // officer editing this event must not see the date jump a day.
    expect(toLocalInputValue(new Date("2026-08-29T02:00:00Z"))).toBe(
      "2026-08-28T22:00",
    );
  });

  /**
   * `hour12: false` asks for a 24-hour clock but not for a particular hour
   * cycle: h23 writes midnight as "00", h24 writes it as "24". A datetime-local
   * input rejects "24:00" outright and shows an empty field, which reads as
   * "this event has no start time" on the edit form.
   */
  it("writes midnight as 00:00, never 24:00", () => {
    expect(toLocalInputValue(new Date("2026-08-29T04:00:00Z"))).toBe(
      "2026-08-29T00:00",
    );
    expect(toLocalInputValue(new Date("2026-01-15T05:00:00Z"))).toBe(
      "2026-01-15T00:00",
    );
  });
});

describe("fromLocalInputValue", () => {
  it("reads a summer wall clock as EDT", () => {
    expect(fromLocalInputValue("2026-07-04T12:00").toISOString()).toBe(
      "2026-07-04T16:00:00.000Z",
    );
  });

  it("reads a winter wall clock as EST", () => {
    expect(fromLocalInputValue("2026-01-04T12:00").toISOString()).toBe(
      "2026-01-04T17:00:00.000Z",
    );
  });

  /**
   * Why the offset is computed per instant instead of being a constant.
   *
   * Typing "12:00" into the form in July and typing "12:00" into it in January
   * must store two different instants, one hour apart. A hardcoded -05:00 (or
   * -04:00) would shift every event in half the year by an hour — late enough
   * that people show up to a locked room.
   */
  it("resolves the same wall clock to different instants across DST", () => {
    const summer = fromLocalInputValue("2026-07-04T12:00");
    const winter = fromLocalInputValue("2026-01-04T12:00");

    expect(summer.getUTCHours()).not.toBe(winter.getUTCHours());
    expect(offsetHours("2026-07-04T12:00")).toBe(-4);
    expect(offsetHours("2026-01-04T12:00")).toBe(-5);
  });

  it("returns a real Date for a well-formed value", () => {
    const value = fromLocalInputValue("2026-09-17T19:30");
    expect(value).toBeInstanceOf(Date);
    expect(Number.isNaN(value.getTime())).toBe(false);
  });
});

describe("toLocalInputValue / fromLocalInputValue round trip", () => {
  /**
   * The edit form reads a stored instant into the input and writes whatever
   * comes back out. Any asymmetry between the two halves silently walks an
   * event's start time every time an officer saves an unrelated field, so the
   * pair is pinned across the whole year and both sides of both transitions.
   */
  const wallClocks = [
    "2026-01-04T12:00",
    "2026-02-14T00:00",
    "2026-03-07T23:30", // the evening before spring forward, still EST
    "2026-03-08T01:59", // the last minute that exists as EST
    "2026-03-08T03:00", // the first minute that exists as EDT
    "2026-04-18T16:45",
    "2026-05-01T08:00",
    "2026-06-15T09:15",
    "2026-07-04T12:00",
    "2026-08-28T18:00",
    "2026-09-30T23:59",
    "2026-10-31T13:45",
    "2026-11-01T00:30", // the last half hour before the clocks fall back
    "2026-11-01T02:00", // the first unambiguous minute after them
    "2026-12-31T23:59",
    "2027-02-14T00:00",
  ];

  it.each(wallClocks)("round trips %s", (wall) => {
    expect(toLocalInputValue(fromLocalInputValue(wall))).toBe(wall);
  });
});

describe("daylight saving edges", () => {
  /**
   * 2:30 AM on 8 March 2026 never happens in Atlanta — the clocks go from
   * 01:59:59 EST straight to 03:00:00 EDT. A `datetime-local` input will still
   * hand that string over, because the browser has no idea which zone the value
   * is meant for. The invariant that can be held is that the conversion lands
   * on a real instant either side of the gap and never on an Invalid Date,
   * which would reach the database as null or throw on the next format() call.
   */
  it("resolves the spring-forward gap to a real instant", () => {
    const value = fromLocalInputValue("2026-03-08T02:30");

    expect(Number.isNaN(value.getTime())).toBe(false);
    // Reading 02:30 as EDT gives 06:30Z, as EST gives 07:30Z. Either is a
    // defensible answer for a wall clock that does not exist; neither is NaN.
    expect(["2026-03-08T06:30:00.000Z", "2026-03-08T07:30:00.000Z"]).toContain(
      value.toISOString(),
    );
    // Whatever it picked has to be renderable back into the input.
    expect(toLocalInputValue(value)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("resolves the top of the spring-forward gap to a real instant", () => {
    const value = fromLocalInputValue("2026-03-08T02:00");

    expect(Number.isNaN(value.getTime())).toBe(false);
    expect(["2026-03-08T06:00:00.000Z", "2026-03-08T07:00:00.000Z"]).toContain(
      value.toISOString(),
    );
  });

  /**
   * 1:30 AM on 1 November 2026 happens twice: once at 05:30Z on EDT and again
   * at 06:30Z on EST. Which one an officer meant is unknowable from the string,
   * so the resolution is not asserted — but both candidates print back as the
   * same wall clock, so the round trip still has to hold, and an hour that is
   * merely ambiguous must not produce NaN.
   */
  it("resolves the autumn ambiguous hour without throwing", () => {
    const value = fromLocalInputValue("2026-11-01T01:30");

    expect(Number.isNaN(value.getTime())).toBe(false);
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(
      value.toISOString(),
    );
    expect(toLocalInputValue(value)).toBe("2026-11-01T01:30");
  });

  it("resolves the top of the autumn ambiguous hour without throwing", () => {
    const value = fromLocalInputValue("2026-11-01T01:00");

    expect(Number.isNaN(value.getTime())).toBe(false);
    expect(toLocalInputValue(value)).toBe("2026-11-01T01:00");
  });
});

describe("formatEventTime", () => {
  it("prints a known instant as the Atlanta wall clock", () => {
    expect(spaces(formatEventTime(new Date("2026-08-28T22:00:00Z")))).toBe(
      "Fri, Aug 28, 6:00 PM",
    );
  });

  it("keeps a late event on the Atlanta day, not the UTC one", () => {
    // 02:00Z on the 29th. UTC has already rolled over; Atlanta has not.
    expect(spaces(formatEventTime(new Date("2026-08-29T02:00:00Z")))).toBe(
      "Fri, Aug 28, 10:00 PM",
    );
  });

  it("prints a winter instant on the standard-time offset", () => {
    expect(spaces(formatEventTime(new Date("2026-01-15T17:30:00Z")))).toBe(
      "Thu, Jan 15, 12:30 PM",
    );
  });
});

describe("formatDate", () => {
  it("prints a known instant", () => {
    expect(formatDate(new Date("2026-08-28T22:00:00Z"))).toBe("Aug 28, 2026");
  });

  /**
   * The off-by-one-day bug this pins: an evening event stored at 02:00Z is
   * still the previous date in Atlanta. Formatting it in UTC dates the whole
   * attendance record to the wrong day.
   */
  it("dates a late event by the Atlanta day", () => {
    expect(formatDate(new Date("2026-08-29T02:00:00Z"))).toBe("Aug 28, 2026");
  });

  it("carries the correction across a year boundary", () => {
    expect(formatDate(new Date("2027-01-01T03:00:00Z"))).toBe("Dec 31, 2026");
  });
});

describe("formatMonth", () => {
  it("prints a known instant as month and year", () => {
    expect(formatMonth(new Date("2026-08-28T22:00:00Z"))).toBe("August 2026");
  });

  /**
   * "Member since" on the card comes from the first check-in. Someone who
   * checked in at a 10 PM event on 31 August is a member since August, not
   * September — the UTC instant says the first, the card must not.
   */
  it("keeps a late-in-the-month instant in the Atlanta month", () => {
    expect(formatMonth(new Date("2026-09-01T02:00:00Z"))).toBe("August 2026");
  });

  it("keeps a late-in-the-year instant in the Atlanta year", () => {
    expect(formatMonth(new Date("2027-01-01T03:00:00Z"))).toBe("December 2026");
  });
});
