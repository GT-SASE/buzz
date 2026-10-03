import { site } from "~/data/site";
import { EVENT_CALENDAR_LENGTH_MS } from "@buzz/api/event-length";

/** "2026-10-20T22:00:00.000Z" -> "20261020T220000Z", the form Google expects. */
function calendarStamp(date: Date) {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** A Google Calendar "add event" link, prefilled. Works for any Gmail account. */
export function googleCalendarUrl(event: {
  title: string;
  startsAt: Date;
  location: string | null;
  description: string | null;
}) {
  const end = new Date(event.startsAt.getTime() + EVENT_CALENDAR_LENGTH_MS);
  const details = [event.description, `${site.url}/events`]
    .filter(Boolean)
    .join("\n\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates: `${calendarStamp(event.startsAt)}/${calendarStamp(end)}`,
    details,
  });
  if (event.location) params.set("location", event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
