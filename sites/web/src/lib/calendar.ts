import { site } from "~/data/site";
import { EVENT_CALENDAR_LENGTH_MS } from "@buzz/api/event-length";
import { addDays, localDateKey } from "~/lib/event-time";

/** "2026-10-20T22:00:00.000Z" -> "20261020T220000Z", the form Google expects. */
function calendarStamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** "2026-12-04" -> "20261204", Google's form for a whole day. */
const dayStamp = (day: string) => day.replaceAll("-", "");

/**
 * A Google Calendar "add event" link, prefilled. Works for any Gmail account.
 * A `reminder` is date-only, so it is a whole day on the chapter-local date
 * and not a timed slot at whatever hour was stored, as in the .ics feed.
 */
export function googleCalendarUrl(event: {
  title: string;
  startsAt: Date;
  location: string | null;
  description: string | null;
  reminder?: boolean;
}) {
  const end = new Date(event.startsAt.getTime() + EVENT_CALENDAR_LENGTH_MS);
  let dates = `${calendarStamp(event.startsAt)}/${calendarStamp(end)}`;
  if (event.reminder) {
    const day = localDateKey(event.startsAt);
    dates = `${dayStamp(day)}/${dayStamp(addDays(day, 1))}`;
  }
  const details = [event.description, `${site.url}/events`]
    .filter(Boolean)
    .join("\n\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    details,
  });
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
