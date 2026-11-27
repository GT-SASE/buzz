import { site } from "~/data/site";
import { addDays, eventEnd, localDateKey } from "~/lib/event-time";
import { icsDate, icsDateTime } from "~/lib/ics";

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
  let dates = `${icsDateTime(event.startsAt)}/${icsDateTime(eventEnd(event))}`;
  if (event.reminder) {
    const day = localDateKey(event.startsAt);
    dates = `${icsDate(day)}/${icsDate(addDays(day, 1))}`;
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
