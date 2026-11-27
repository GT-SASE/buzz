import { describe, expect, it } from "bun:test";

import {
  buildCalendar,
  escapeText,
  foldLine,
  icsDateTime,
  type CalendarEvent,
} from "~/lib/ics";

const octets = (text: string) => new TextEncoder().encode(text).length;
const unfold = (text: string) => text.replaceAll("\r\n ", "");

describe("escapeText", () => {
  it("escapes backslash, semicolon and comma, in that order", () => {
    expect(escapeText(String.raw`a\b;c,d`)).toBe(String.raw`a\\b\;c\,d`);
  });

  it("turns every kind of line break into a literal \\n", () => {
    expect(escapeText("one\r\ntwo\rthree\nfour five six")).toBe(
      String.raw`one\ntwo\nthree\nfour\nfive\nsix`,
    );
  });

  it("drops control characters that have no legal spelling, keeps tabs", () => {
    expect(escapeText("a\u0000b\u0007c\u001fd\u007fe\tf")).toBe("abcde\tf");
  });
});

describe("foldLine", () => {
  it("leaves a line of exactly 75 octets alone and folds one of 76", () => {
    const exact = "X".repeat(75);
    expect(foldLine(exact)).toBe(exact);
    expect(foldLine(exact + "X")).toBe(`${exact}\r\n X`);
  });

  it("keeps every physical line within 75 octets, continuation space included", () => {
    const folded = foldLine(`DESCRIPTION:${"word ".repeat(200)}`);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) expect(octets(line)).toBeLessThanOrEqual(75);
    for (const line of lines.slice(1)) expect(line.startsWith(" ")).toBe(true);
  });

  it("counts octets, not characters, and never splits a multi-byte character", () => {
    // 2-byte, 3-byte and 4-byte characters mixed so a fold can land anywhere.
    const text = `SUMMARY:${"é汉😀".repeat(60)}`;
    const folded = foldLine(text);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const line of folded.split("\r\n")) {
      expect(octets(line)).toBeLessThanOrEqual(75);
      // fatal: throws on a split sequence
      expect(() =>
        decoder.decode(new TextEncoder().encode(line)),
      ).not.toThrow();
    }
    expect(unfold(folded)).toBe(text);
  });

  it("unfolds back to the original line", () => {
    const text = `LOCATION:${"Student Center, Room 117 ".repeat(20)}`;
    expect(unfold(foldLine(text))).toBe(text);
  });
});

describe("icsDateTime", () => {
  it("is UTC, zero padded and ends in Z", () => {
    expect(icsDateTime(new Date("2026-03-05T04:07:09.999Z"))).toBe(
      "20260305T040709Z",
    );
  });
});

const event: CalendarEvent = {
  uid: "abc-123@example.org",
  summary: "GBM 4: Friendsgiving, Social; bring food",
  description: "Line one\nLine two",
  location: "Student Center, Room 117",
  url: "https://example.org/events/abc-123",
  modified: new Date("2026-11-01T12:00:00Z"),
  start: new Date("2026-11-24T23:00:00Z"),
  end: new Date("2026-11-25T00:30:00Z"),
};

function feed(events: CalendarEvent[]) {
  return buildCalendar({
    productId: "-//Test//Feed//EN",
    name: "Test, calendar",
    description: "About; it",
    refreshHours: 1,
    events,
  });
}

describe("buildCalendar", () => {
  const body = feed([event]);

  it("wraps the events in a VCALENDAR with the required properties", () => {
    const lines = body.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//Test//Feed//EN");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(lines.at(-2)).toBe("END:VCALENDAR");
  });

  it("ends every line, the last included, with CRLF and never a bare LF", () => {
    expect(body.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(body).not.toMatch(/(?<!\r)\n/);
    expect(body).not.toMatch(/\r(?!\n)/);
  });

  it("escapes text properties and writes UTC times", () => {
    const lines = body.split("\r\n");
    expect(lines).toContain(
      String.raw`SUMMARY:GBM 4: Friendsgiving\, Social\; bring food`,
    );
    expect(lines).toContain(String.raw`DESCRIPTION:Line one\nLine two`);
    expect(lines).toContain(String.raw`LOCATION:Student Center\, Room 117`);
    expect(lines).toContain(String.raw`X-WR-CALNAME:Test\, calendar`);
    expect(lines).toContain("DTSTART:20261124T230000Z");
    expect(lines).toContain("DTEND:20261125T003000Z");
    expect(lines).toContain("URL:https://example.org/events/abc-123");
  });

  it("stamps DTSTAMP and LAST-MODIFIED from the event, not the clock", () => {
    const lines = body.split("\r\n");
    expect(lines).toContain("DTSTAMP:20261101T120000Z");
    expect(lines).toContain("LAST-MODIFIED:20261101T120000Z");
  });

  it("is byte-identical for the same input, with a UID that does not move", () => {
    expect(feed([event])).toBe(body);
    const retitled = feed([{ ...event, summary: "Renamed" }]);
    expect(retitled).toContain("UID:abc-123@example.org\r\n");
    expect(retitled).not.toBe(body);
  });

  it("writes a whole-day event with VALUE=DATE and no time", () => {
    const allDay = feed([
      {
        ...event,
        allDay: { start: "2026-12-04", end: "2026-12-05" },
      },
    ]);
    expect(allDay).toContain("DTSTART;VALUE=DATE:20261204\r\n");
    expect(allDay).toContain("DTEND;VALUE=DATE:20261205\r\n");
    expect(allDay).not.toContain("DTSTART:");
  });

  it("omits LOCATION, DESCRIPTION and URL when the event has none", () => {
    const bare = feed([
      {
        uid: "bare@example.org",
        summary: "Bare",
        modified: event.modified,
        start: event.start,
        end: event.end,
      },
    ]);
    expect(bare).not.toContain("LOCATION");
    expect(bare).not.toContain("DESCRIPTION");
    expect(bare).not.toContain("URL:");
  });

  it("keeps every line within 75 octets however long the text is", () => {
    const long = feed([
      {
        ...event,
        summary: "Résumé review 😀 ".repeat(30),
        description: "Bring a laptop; we build, then eat. ".repeat(40),
      },
    ]);
    for (const line of long.split("\r\n"))
      expect(octets(line)).toBeLessThanOrEqual(75);
    // Unfolding restores the escaped text.
    expect(unfold(long)).toContain(
      String.raw`DESCRIPTION:Bring a laptop\; we build\, then eat. Bring`,
    );
  });
});

/**
 * A reader written from RFC 5545 §3.1 and §3.3.11 rather than from the writer:
 * unfold, split `NAME;PARAM=x:VALUE`, unescape TEXT. If the writer and this
 * disagree, one of them is wrong.
 */
function read(body: string) {
  expect(body.endsWith("\r\n")).toBe(true);
  const physical = body.slice(0, -2).split("\r\n");
  const logical: string[] = [];
  for (const line of physical) {
    expect(octets(line)).toBeLessThanOrEqual(75);
    if (line.startsWith(" ")) logical[logical.length - 1] += line.slice(1);
    else logical.push(line);
  }
  const unescape = (value: string) =>
    value.replace(/\\([\\;,nN])/g, (_, char: string) =>
      char === "n" || char === "N" ? "\n" : char,
    );
  const events: Record<string, string>[] = [];
  const calendar: Record<string, string> = {};
  let current: Record<string, string> | null = null;
  for (const line of logical) {
    const colon = line.indexOf(":");
    expect(colon).toBeGreaterThan(0);
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (name === "BEGIN" && value === "VEVENT") current = {};
    else if (name === "END" && value === "VEVENT") {
      events.push(current!);
      current = null;
    } else if (name !== "BEGIN" && name !== "END") {
      (current ?? calendar)[name] = unescape(value);
    }
  }
  expect(current).toBeNull();
  return { calendar, events };
}

describe("round trip", () => {
  const nasty = [
    "plain",
    "commas, semicolons; backslash \\ and \\n literally",
    "two\nlines\r\nand a third\rone",
    "Résumé review 😀 汉字 ".repeat(15),
    "x".repeat(74) + ",",
    "x".repeat(150),
    "",
  ];

  it.each(nasty)("reads back exactly what was written: %j", (text) => {
    const { events } = read(
      buildCalendar({
        productId: "-//Test//Feed//EN",
        name: text || "n",
        events: [
          {
            ...event,
            summary: text || "s",
            description: text || null,
            location: text || null,
          },
        ],
      }),
    );
    const normalized = text.replace(/\r\n|\r/g, "\n");
    expect(events).toHaveLength(1);
    expect(events[0]!.SUMMARY).toBe(normalized || "s");
    expect(events[0]!.DESCRIPTION).toBe(normalized || undefined);
    expect(events[0]!.LOCATION).toBe(normalized || undefined);
    expect(events[0]!.UID).toBe(event.uid);
  });

  it("reads a whole feed back with one UID per event and every time in UTC", () => {
    const { calendar, events } = read(
      feed(
        [1, 2, 3].map((n) => ({
          ...event,
          uid: `e${n}@example.org`,
          summary: `Event ${n}`,
        })),
      ),
    );
    expect(calendar.VERSION).toBe("2.0");
    expect(events.map((e) => e.UID)).toEqual([
      "e1@example.org",
      "e2@example.org",
      "e3@example.org",
    ]);
    for (const e of events) {
      expect(e.DTSTAMP).toMatch(/^\d{8}T\d{6}Z$/);
      expect(e.DTSTART).toMatch(/^\d{8}T\d{6}Z$/);
      expect(e.DTEND).toMatch(/^\d{8}T\d{6}Z$/);
      expect(e.DTEND! > e.DTSTART!).toBe(true);
    }
  });
});
