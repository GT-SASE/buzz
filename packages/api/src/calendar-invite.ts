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

/** Why an organizer sends an invite the member did not ask for. */
export type EventChange = "moved" | "cancelled" | "restored";

const copy: Record<
  EventChange,
  (title: string) => { subject: string; text: string }
> = {
  moved: (title) => ({
    subject: `Updated: ${title}`,
    text: `The time or place of ${title} changed. Your calendar entry is updated.`,
  }),
  cancelled: (title) => ({
    subject: `Cancelled: ${title}`,
    text: `${title} is cancelled. It is off your calendar.`,
  }),
  restored: (title) => ({
    subject: `Back on: ${title}`,
    text: `${title} is back on after being cancelled. It is on your calendar again.`,
  }),
};

/**
 * Puts the event on the member's calendar (REQUEST) or takes it off (CANCEL).
 * With `change` the organizer is revising an entry already sent (same UID and
 * a later SEQUENCE, so the calendar replaces it instead of adding one) and the
 * message says what happened to the event. Without it the member RSVPed or
 * cancelled their own RSVP. Returns false when sending is not configured or
 * fails; the change itself has already been saved either way.
 */
export async function sendCalendarInvite(
  method: "REQUEST" | "CANCEL",
  event: InviteEvent,
  attendee: string,
  {
    change,
    mail = mailer(),
  }: { change?: EventChange; mail?: Mailer | null } = {},
) {
  if (!mail) return false;
  const message = change
    ? copy[change](event.title)
    : method === "CANCEL"
      ? {
          subject: `Cancelled: ${event.title}`,
          text: `Your RSVP for ${event.title} is cancelled.`,
        }
      : {
          subject: `You're going: ${event.title}`,
          text: `See you at ${event.title}. It's on your calendar.`,
        };
  return deliver(
    mail,
    {
      to: attendee,
      ...message,
      icalEvent: {
        method,
        content: inviteIcs({ method, event, organizer: mail.user, attendee }),
      },
    },
    "Calendar invite",
  );
}
