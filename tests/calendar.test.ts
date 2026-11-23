import { describe, expect, it } from "bun:test";

import { googleCalendarUrl } from "~/lib/calendar";

const base = {
  title: "Campus Career Fair",
  location: null,
  description: null,
};

const datesOf = (url: string) => new URL(url).searchParams.get("dates")!;

describe("Add to Google Calendar", () => {
  it("is a timed window for an event, starting when it starts", () => {
    const url = googleCalendarUrl({
      ...base,
      startsAt: new Date("2026-11-24T23:00:00.000Z"),
    });
    expect(datesOf(url)).toBe("20261124T230000Z/20261125T003000Z");
  });

  it("is a whole day for a date-only reminder", () => {
    const url = googleCalendarUrl({
      ...base,
      reminder: true,
      startsAt: new Date("2026-12-04T15:00:00.000Z"),
    });
    expect(datesOf(url)).toBe("20261204/20261205");
  });

  it("keeps a reminder on the chapter's day, not the UTC one", () => {
    // 11 pm on Dec 4 in Atlanta is already Dec 5 in UTC.
    const url = googleCalendarUrl({
      ...base,
      reminder: true,
      startsAt: new Date("2026-12-05T04:00:00.000Z"),
    });
    expect(datesOf(url)).toBe("20261204/20261205");
  });

  it("rolls a reminder's end over a month and a year", () => {
    expect(
      datesOf(
        googleCalendarUrl({
          ...base,
          reminder: true,
          startsAt: new Date("2026-12-31T17:00:00.000Z"),
        }),
      ),
    ).toBe("20261231/20270101");
  });
});
