import { EVENT_CALENDAR_LENGTH_MS } from "./event-length";
import { deliver, mailer, SENDER_NAME, type Mailer } from "./mail";

export type InviteEvent = {
  id: string;
  title: string;
  startsAt: Date;
  location: string | null;
  description: string | null;
};

/** "2026-10-20T22:00:00.000Z" -> "20261020T220000Z". */
function stamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** RFC 5545 text: backslash, semicolon, comma and newline are escaped. */
function text(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * One invite per member per event. The UID is stable so a cancel replaces the
 * same entry, and SEQUENCE only ever grows so a re-RSVP after a cancel is
 * treated as newer than the cancel.
 */
export function inviteIcs({
  method,
  event,
  organizer,
  attendee,
  now = new Date(),
}: {
  method: "REQUEST" | "CANCEL";
  event: InviteEvent;
  organizer: string;
  attendee: string;
  now?: Date;
}) {
  const end = new Date(event.startsAt.getTime() + EVENT_CALENDAR_LENGTH_MS);
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//GT SASE//Buzz//EN",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:rsvp-${event.id}-${text(attendee)}@buzz`,
    `SEQUENCE:${Math.floor(now.getTime() / 1000)}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(event.startsAt)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${text(event.title)}`,
    event.location ? `LOCATION:${text(event.location)}` : null,
    event.description ? `DESCRIPTION:${text(event.description)}` : null,
    `ORGANIZER;CN=${SENDER_NAME}:mailto:${organizer}`,
    `ATTENDEE;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${attendee}`,
    `STATUS:${method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.filter((line) => line !== null).join("\r\n");
}

/**
 * Puts the event on the member's calendar (REQUEST) or takes it off (CANCEL).
 * `updated` marks a REQUEST that revises an entry already sent: same UID and a
 * later SEQUENCE, so the calendar replaces the entry instead of adding one.
 * Returns false when sending is not configured or fails; the RSVP itself has
 * already been saved either way.
 */
export async function sendCalendarInvite(
  method: "REQUEST" | "CANCEL",
  event: InviteEvent,
  attendee: string,
  {
    updated = false,
    mail = mailer(),
  }: { updated?: boolean; mail?: Mailer | null } = {},
) {
  if (!mail) return false;
  return deliver(
    mail,
    {
      to: attendee,
      subject:
        method === "CANCEL"
          ? `Cancelled: ${event.title}`
          : updated
            ? `Updated: ${event.title}`
            : `You're going: ${event.title}`,
      text:
        method === "CANCEL"
          ? `Your RSVP for ${event.title} is cancelled.`
          : updated
            ? `The time or place of ${event.title} changed. Your calendar entry is updated.`
            : `See you at ${event.title}. It's on your calendar.`,
      icalEvent: {
        method,
        content: inviteIcs({ method, event, organizer: mail.user, attendee }),
      },
    },
    "Calendar invite",
  );
}
