import { describe, expect, it } from "bun:test";

import {
  eventMonthPath,
  eventPagePath,
} from "../sites/web/src/app/portal/_lib/paths";
import { site } from "~/data/site";
import {
  addDays,
  eventDays,
  isSettled,
  isMonthKey,
  localDateKey,
  monthBounds,
  monthGrid,
  monthKeyOf,
  shiftMonth,
  type SpanEvent,
} from "~/lib/event-time";
import {
  eventsCalendar,
  FEED_PAST_DAYS,
  type FeedEvent,
} from "~/lib/events-feed";
import { clipText, eventSchema, pageMetadata } from "~/lib/seo";
import { buildSitemap } from "~/lib/sitemap";

const at = (iso: string): Date => new Date(iso);

function span(id: string, startsAt: string, reminder = false): SpanEvent {
  return { id, title: id, startsAt: at(startsAt), reminder };
}

describe("localDateKey", () => {
  it("reads the day in the chapter's zone, not UTC", () => {
    expect(localDateKey(at("2026-11-24T04:59:59Z"))).toBe("2026-11-23");
    expect(localDateKey(at("2026-11-24T05:00:00Z"))).toBe("2026-11-24");
    // Daylight time: one hour earlier.
    expect(localDateKey(at("2026-07-04T03:59:59Z"))).toBe("2026-07-03");
    expect(localDateKey(at("2026-07-04T04:00:00Z"))).toBe("2026-07-04");
  });

  it("follows the clock change instead of a fixed offset", () => {
    // Spring forward 2027-03-14: from 07:00Z the offset is -4, not -5.
    expect(localDateKey(at("2027-03-15T03:59:59Z"))).toBe("2027-03-14");
    expect(localDateKey(at("2027-03-15T04:00:00Z"))).toBe("2027-03-15");
    // Fall back 2026-11-01: from 06:00Z the offset is -5, not -4.
    expect(localDateKey(at("2026-11-02T04:59:59Z"))).toBe("2026-11-01");
    expect(localDateKey(at("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
  });
});

describe("day and month keys", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
  });

  it("shifts months across a year", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
    expect(shiftMonth("2026-11", 14)).toBe("2028-01");
    expect(shiftMonth("2026-11", -11)).toBe("2025-12");
  });

  it("accepts only a real YYYY-MM", () => {
    expect(isMonthKey("2026-11")).toBe(true);
    for (const bad of [
      "2026-13",
      "2026-00",
      "2026-1",
      "26-11",
      "2026-11-01",
      "",
    ])
      expect(isMonthKey(bad)).toBe(false);
  });
});

describe("eventDays", () => {
  it("puts an evening event on one day", () => {
    expect(eventDays(span("a", "2026-11-24T23:00:00Z"))).toEqual([
      "2026-11-24",
    ]);
  });

  it("puts an event that runs past midnight on both days", () => {
    // 11:30 pm EST to 1:00 am.
    expect(eventDays(span("a", "2026-11-28T04:30:00Z"))).toEqual([
      "2026-11-27",
      "2026-11-28",
    ]);
  });

  it("does not reach into the next day when it ends exactly at midnight", () => {
    // 10:30 pm EST + 90 minutes = midnight.
    expect(eventDays(span("a", "2026-11-24T03:30:00Z"))).toEqual([
      "2026-11-23",
    ]);
  });

  it("puts a date-only listing on its own day whatever time is stored", () => {
    expect(eventDays(span("a", "2026-11-28T04:30:00Z", true))).toEqual([
      "2026-11-27",
    ]);
  });

  it("splits at the spring-forward night by local midnight, not 24 hours", () => {
    // 11:30 pm EST Mar 13 to 1:00 am EST Mar 14.
    expect(eventDays(span("a", "2027-03-14T04:30:00Z"))).toEqual([
      "2027-03-13",
      "2027-03-14",
    ]);
    // 12:30 am EST Mar 14 to 3:00 am EDT: the clock skips an hour inside it.
    expect(eventDays(span("b", "2027-03-14T05:30:00Z"))).toEqual([
      "2027-03-14",
    ]);
    // 12:30 am EDT Mar 15 is Mar 15, though a fixed -5 offset says 11:30 pm Mar 14.
    expect(eventDays(span("c", "2027-03-15T04:30:00Z"))).toEqual([
      "2027-03-15",
    ]);
  });

  it("splits at the fall-back night by local midnight, not 24 hours", () => {
    // 11:30 pm EDT Oct 31 to 1:00 am EDT Nov 1.
    expect(eventDays(span("a", "2026-11-01T03:30:00Z"))).toEqual([
      "2026-10-31",
      "2026-11-01",
    ]);
    // 11:30 pm EST Nov 1 (the day was 25 hours long) to 1:00 am Nov 2.
    expect(eventDays(span("b", "2026-11-02T04:30:00Z"))).toEqual([
      "2026-11-01",
      "2026-11-02",
    ]);
    // 1:30 am EDT, an hour before the clock goes back: still Nov 1.
    expect(eventDays(span("c", "2026-11-01T05:30:00Z"))).toEqual([
      "2026-11-01",
    ]);
  });
});

describe("monthGrid", () => {
  it("builds full Sunday-first weeks and only as many as the month needs", () => {
    // Nov 1 2026 is a Sunday, Feb 2026 starts on a Sunday and has 28 days,
    // Aug 2026 starts on a Saturday and has 31.
    const nov = monthGrid("2026-11", []);
    const feb = monthGrid("2026-02", []);
    const aug = monthGrid("2026-08", []);
    expect(nov).toHaveLength(5);
    expect(feb).toHaveLength(4);
    expect(aug).toHaveLength(6);
    for (const weeks of [nov, feb, aug])
      for (const week of weeks) expect(week).toHaveLength(7);
    expect(nov[0]![0]).toMatchObject({ key: "2026-11-01", inMonth: true });
    expect(aug[0]![0]).toMatchObject({ key: "2026-07-26", inMonth: false });
    expect(aug[0]![6]).toMatchObject({ key: "2026-08-01", inMonth: true });
    expect(aug[5]![0]).toMatchObject({ key: "2026-08-30", inMonth: true });
    expect(aug[5]![1]).toMatchObject({ key: "2026-08-31", inMonth: true });
    expect(aug[5]![2]).toMatchObject({ key: "2026-09-01", inMonth: false });
  });

  it("files events under their local day, soonest first", () => {
    const grid = monthGrid("2026-11", [
      span("late", "2026-11-25T01:00:00Z"), // 8 pm Nov 24
      span("early", "2026-11-24T20:00:00Z"), // 3 pm Nov 24
      span("other", "2026-12-02T23:00:00Z"),
    ]);
    const day = grid.flat().find((cell) => cell.key === "2026-11-24")!;
    expect(day.entries.map((entry) => entry.event.id)).toEqual([
      "early",
      "late",
    ]);
    expect(grid.flat().flatMap((cell) => cell.entries)).toHaveLength(2);
  });

  it("shows an event that runs past midnight on both days", () => {
    const grid = monthGrid("2026-11", [span("jam", "2026-11-28T04:30:00Z")]);
    const cells = grid.flat();
    expect(cells.find((c) => c.key === "2026-11-27")!.entries[0]).toMatchObject(
      {
        startsHere: true,
        endsHere: false,
      },
    );
    expect(cells.find((c) => c.key === "2026-11-28")!.entries[0]).toMatchObject(
      {
        startsHere: false,
        endsHere: true,
      },
    );
  });

  it("carries an event across a month boundary into the right month only", () => {
    // 11:30 pm EDT Oct 31 to 1:00 am Nov 1.
    const jam = span("jam", "2026-11-01T03:30:00Z");
    const nov = monthGrid("2026-11", [jam]);
    expect(nov[0]![0]).toMatchObject({ key: "2026-11-01", inMonth: true });
    expect(nov[0]![0]!.entries[0]).toMatchObject({
      startsHere: false,
      endsHere: true,
    });
    const oct = monthGrid("2026-10", [jam]);
    const last = oct.at(-1)!.at(-1)!;
    expect(last.key).toBe("2026-10-31");
    expect(last.entries[0]).toMatchObject({
      startsHere: true,
      endsHere: false,
    });
    // The October grid pads with Nov 1, which belongs to November's page.
    expect(oct.flat().filter((c) => !c.inMonth && c.entries.length)).toEqual(
      [],
    );
  });

  it("puts an event on the clock-change day in its own cell", () => {
    const grid = monthGrid("2027-03", [
      span("skip", "2027-03-14T05:30:00Z"),
      span("after", "2027-03-15T04:30:00Z"),
    ]);
    expect(grid[2]![0]).toMatchObject({ key: "2027-03-14" });
    expect(grid[2]![0]!.entries.map((e) => e.event.id)).toEqual(["skip"]);
    expect(grid[2]![1]!.entries.map((e) => e.event.id)).toEqual(["after"]);
  });
});

describe("monthBounds", () => {
  const now = at("2026-11-22T17:00:00Z");

  it("is the current month when there are no events", () => {
    expect(monthBounds([], now)).toEqual({ first: "2026-11", last: "2026-11" });
  });

  it("stretches from the earliest to the latest event, current month included", () => {
    expect(
      monthBounds(
        [span("a", "2025-11-20T23:00:00Z"), span("b", "2027-03-14T05:30:00Z")],
        now,
      ),
    ).toEqual({ first: "2025-11", last: "2027-03" });
    expect(monthBounds([span("a", "2026-12-02T23:00:00Z")], now)).toEqual({
      first: "2026-11",
      last: "2026-12",
    });
  });

  it("reads an event's month in the chapter's zone", () => {
    // 11 pm Nov 30 EST is already Dec 1 in UTC.
    expect(monthKeyOf(at("2026-12-01T04:00:00Z"))).toBe("2026-11");
  });
});

describe("events feed", () => {
  const now = at("2026-11-22T17:00:00Z");
  const base: FeedEvent = {
    id: "11111111-1111-4111-8111-000000000004",
    title: "GBM 4",
    description: "Bring a dish, or just yourself.",
    location: "Student Center, Room 117",
    startsAt: at("2026-11-24T23:00:00Z"),
    modifiedAt: at("2026-11-01T12:00:00Z"),
    reminder: false,
  };

  it("gives each event one UID built from its id and the canonical host", () => {
    const body = eventsCalendar([base], now);
    expect(body).toContain(`UID:${base.id}@${new URL(site.url).hostname}\r\n`);
    // Editing the event changes what the entry says, not which entry it is.
    const edited = eventsCalendar(
      [
        {
          ...base,
          title: "GBM 4 (moved)",
          startsAt: at("2026-11-25T23:00:00Z"),
        },
      ],
      now,
    );
    const uid = /UID:.*/;
    expect(uid.exec(edited)![0]).toBe(uid.exec(body)![0]);
  });

  it("returns the same bytes every time for the same events", () => {
    expect(eventsCalendar([base], now)).toBe(eventsCalendar([base], now));
  });

  it("is a 90-minute entry that links to the event page", () => {
    const body = eventsCalendar([base], now);
    expect(body).toContain("DTSTART:20261124T230000Z\r\n");
    expect(body).toContain("DTEND:20261125T003000Z\r\n");
    expect(body).toContain(`URL:${site.url}${eventPagePath(base.id)}\r\n`);
    expect(body).toContain("DTSTAMP:20261101T120000Z\r\n");
  });

  it("lists a date-only listing as a whole day, in the chapter's zone", () => {
    const body = eventsCalendar(
      [{ ...base, reminder: true, startsAt: at("2026-12-04T15:00:00Z") }],
      now,
    );
    expect(body).toContain("DTSTART;VALUE=DATE:20261204\r\n");
    expect(body).toContain("DTEND;VALUE=DATE:20261205\r\n");
  });

  it("keeps the recent past and upcoming, and drops the old archive", () => {
    const day = 24 * 60 * 60 * 1000;
    const old = {
      ...base,
      id: "old",
      startsAt: new Date(now.getTime() - (FEED_PAST_DAYS + 1) * day),
    };
    const recent = {
      ...base,
      id: "recent",
      startsAt: new Date(now.getTime() - (FEED_PAST_DAYS - 1) * day),
    };
    const body = eventsCalendar([old, base, recent], now);
    expect(body).not.toContain("UID:old@");
    expect(body.indexOf("UID:recent@")).toBeLessThan(
      body.indexOf(`UID:${base.id}@`),
    );
  });

  it("is a valid empty calendar when nothing is on", () => {
    const body = eventsCalendar([], now);
    expect(body).toContain("BEGIN:VCALENDAR\r\n");
    expect(body).not.toContain("BEGIN:VEVENT");
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});

describe("public event pages", () => {
  it("builds paths that survive an odd id", () => {
    expect(eventPagePath("abc")).toBe("/events/abc");
    expect(eventPagePath("a/b c")).toBe("/events/a%2Fb%20c");
    expect(eventMonthPath("2026-11")).toBe("/events/month/2026-11");
  });

  it("lists each event page in the sitemap with its last edit, upcoming first", () => {
    const modifiedAt = at("2026-11-01T12:00:00Z");
    const entries = buildSitemap(
      [],
      [
        { id: "next", modifiedAt, upcoming: true },
        { id: "done", modifiedAt, upcoming: false },
      ],
    );
    const next = entries.find((e) => e.url === `${site.url}/events/next`);
    const done = entries.find((e) => e.url === `${site.url}/events/done`);
    expect(next?.lastModified).toEqual(modifiedAt);
    expect(next!.priority!).toBeGreaterThan(done!.priority!);
    expect(entries.some((e) => e.url.includes("/events/month"))).toBe(false);
    expect(buildSitemap([]).some((e) => e.url.includes("/events/"))).toBe(
      false,
    );
  });

  it("points an event's structured data at its own page and card", () => {
    const schema = eventSchema({
      id: "abc",
      title: "GBM",
      startsAt: at("2026-11-24T23:00:00Z"),
      location: null,
      description: null,
      image: `${site.url}/events/abc/card?v=1`,
    });
    expect(schema).toMatchObject({
      "@type": "Event",
      "@id": `${site.url}/events/abc`,
      url: `${site.url}/events/abc`,
      image: `${site.url}/events/abc/card?v=1`,
    });
    expect(
      eventSchema({
        title: "GBM",
        startsAt: at("2026-11-24T23:00:00Z"),
        location: null,
        description: null,
      }),
    ).not.toHaveProperty("url");
  });

  it("dates a campus reminder by its chapter-local day, not its stored instant", () => {
    const reminder = (startsAt: string) =>
      eventSchema({
        title: "Career Fair",
        startsAt: at(startsAt),
        location: null,
        description: null,
        reminder: true,
      }).startDate;
    expect(reminder("2026-12-04T15:00:00Z")).toBe("2026-12-04");
    // 10 pm EST Dec 4 is already Dec 5 in UTC, which is the day a naive
    // toISOString().slice(0, 10) would print.
    expect(reminder("2026-12-05T03:00:00Z")).toBe("2026-12-04");
    // A timed event keeps its full instant.
    expect(
      eventSchema({
        title: "GBM",
        startsAt: at("2026-12-04T15:00:00Z"),
        location: null,
        description: null,
      }).startDate,
    ).toBe("2026-12-04T15:00:00.000Z");
  });

  it("lets a page bring its own share image", () => {
    const image = {
      url: `${site.url}/events/abc/card?v=1`,
      width: 1200,
      height: 630,
      alt: "GBM",
      type: "image/png",
    };
    const meta = pageMetadata({
      title: "GBM",
      description: "d",
      path: "/events/abc",
      image,
    });
    expect(meta.openGraph?.images).toEqual([image]);
    expect(meta.twitter?.images).toEqual([image.url]);
  });

  it("clips long copy with an ellipsis and leaves short copy alone", () => {
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("abcdefghij", 10)).toBe("abcdefghij");
    expect(clipText("abcdefghijk", 10)).toBe("abcdefghi…");
  });
});

describe("isSettled", () => {
  const now = at("2026-11-22T17:00:00Z");

  it("holds an event on the calendar for a day after it starts", () => {
    expect(isSettled({ startsAt: at("2026-11-21T17:00:01Z") }, now)).toBe(
      false,
    );
    expect(isSettled({ startsAt: at("2026-11-21T17:00:00Z") }, now)).toBe(
      false,
    );
    expect(isSettled({ startsAt: at("2026-11-21T16:59:59Z") }, now)).toBe(true);
  });

  it("never settles an event that has not started", () => {
    expect(isSettled({ startsAt: at("2026-12-04T15:00:00Z") }, now)).toBe(
      false,
    );
  });
});
