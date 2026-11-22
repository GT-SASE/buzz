/**
 * A small RFC 5545 serializer for a read-only feed of VEVENTs. Written by hand
 * because the feed needs a handful of properties and a dependency would weigh
 * more than these lines. Pure: no site constants, no clock, so the output for
 * a given input never changes.
 */

const CRLF = "\r\n";

/** RFC 5545 §3.1: no content line longer than 75 octets, excluding the CRLF. */
const LINE_OCTETS = 75;

const encoder = new TextEncoder();

/**
 * TEXT values (§3.3.11): backslash, semicolon, comma and line breaks are
 * escaped, and other control characters, which have no legal spelling, are
 * dropped. Unicode line and paragraph separators count as line breaks.
 */
export function escapeText(value: string) {
  return value
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

function utf8Length(codePoint: number) {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Folds one content line at 75 octets (§3.1). The limit is on octets, not
 * characters, and a multi-byte character is never split. Each continuation
 * starts with one space, which counts toward its 75.
 */
export function foldLine(line: string) {
  if (encoder.encode(line).length <= LINE_OCTETS) return line;
  const pieces: string[] = [];
  let piece = "";
  let octets = 0;
  let limit = LINE_OCTETS;
  for (const character of line) {
    const size = utf8Length(character.codePointAt(0)!);
    if (octets + size > limit) {
      pieces.push(piece);
      piece = "";
      octets = 0;
      limit = LINE_OCTETS - 1;
    }
    piece += character;
    octets += size;
  }
  pieces.push(piece);
  return pieces.join(`${CRLF} `);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** `"20261124T230000Z"`, a UTC date-time (§3.3.5 form 2). */
export function icsDateTime(date: Date) {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}T${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/** `"2026-11-24"` to `"20261124"` (§3.3.4). */
export const icsDate = (key: string) => key.replaceAll("-", "");

export type CalendarEvent = {
  /** Globally unique and stable for the life of the event. */
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  url?: string;
  /** DTSTAMP and LAST-MODIFIED: when this version of the event was written. */
  modified: Date;
  /** Exact start and end. */
  start: Date;
  end: Date;
  /** Whole-day event; `end` is the day after the last one, as RFC 5545 has it. */
  allDay?: { start: string; end: string };
};

export type CalendarOptions = {
  /** `PRODID`: who made the calendar. */
  productId: string;
  name: string;
  description?: string;
  /** Hint to subscribers for how often to poll, in hours. */
  refreshHours?: number;
  events: readonly CalendarEvent[];
};

function property(name: string, value: string) {
  return foldLine(`${name}:${value}`);
}

function eventLines(event: CalendarEvent) {
  const lines = [
    "BEGIN:VEVENT",
    property("UID", escapeText(event.uid)),
    property("DTSTAMP", icsDateTime(event.modified)),
  ];
  if (event.allDay) {
    lines.push(
      property("DTSTART;VALUE=DATE", icsDate(event.allDay.start)),
      property("DTEND;VALUE=DATE", icsDate(event.allDay.end)),
    );
  } else {
    lines.push(
      property("DTSTART", icsDateTime(event.start)),
      property("DTEND", icsDateTime(event.end)),
    );
  }
  lines.push(property("SUMMARY", escapeText(event.summary)));
  if (event.location) {
    lines.push(property("LOCATION", escapeText(event.location)));
  }
  if (event.description) {
    lines.push(property("DESCRIPTION", escapeText(event.description)));
  }
  if (event.url) lines.push(property("URL", event.url));
  lines.push(
    property("LAST-MODIFIED", icsDateTime(event.modified)),
    "STATUS:CONFIRMED",
    "END:VEVENT",
  );
  return lines;
}

/** A complete VCALENDAR, CRLF after every line including the last. */
export function buildCalendar(options: CalendarOptions) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    property("PRODID", escapeText(options.productId)),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    property("X-WR-CALNAME", escapeText(options.name)),
  ];
  if (options.description) {
    lines.push(property("X-WR-CALDESC", escapeText(options.description)));
  }
  if (options.refreshHours) {
    // The standard property and the one Google and Outlook read.
    lines.push(
      `REFRESH-INTERVAL;VALUE=DURATION:PT${options.refreshHours}H`,
      `X-PUBLISHED-TTL:PT${options.refreshHours}H`,
    );
  }
  for (const event of options.events) lines.push(...eventLines(event));
  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}
