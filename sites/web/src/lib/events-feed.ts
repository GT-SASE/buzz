import { eventPagePath } from "~/app/portal/_lib/paths";
import { site } from "~/data/site";
import { addDays, eventEnd, localDateKey } from "~/lib/event-time";
import { buildCalendar, type CalendarEvent } from "~/lib/ics";

/** How far back the feed reaches. The archive on /events keeps the rest. */
export const FEED_PAST_DAYS = 90;

/** How often subscribers are told to poll. The feed itself refreshes hourly. */
const REFRESH_HOURS = 1;

const feedHost = new URL(site.url).hostname;

/** The feed's one URL, the canonical origin and not whichever host fetched it. */
export const feedPath = "/events.ics";
export const feedUrl = `${site.url}${feedPath}`;
/** The same feed for calendar apps that register the `webcal` scheme. */
export const webcalUrl = feedUrl.replace(/^https:/, "webcal:");

/** The slice of a public event the feed reads. */
export type FeedEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  /** When the officer last wrote the row; stable between edits. */
  modifiedAt: Date;
  reminder: boolean;
};

function toCalendarEvent(event: FeedEvent): CalendarEvent {
  const url = `${site.url}${eventPagePath(event.id)}`;
  const day = localDateKey(event.startsAt);
  return {
    // The id never changes and the host is the canonical one, so a calendar
    // that re-reads the feed updates an entry instead of adding a second.
    uid: `${event.id}@${feedHost}`,
    summary: event.title,
    description: [event.description, url].filter(Boolean).join("\n\n"),
    location: event.location,
    url,
    modified: event.modifiedAt,
    start: event.startsAt,
    end: eventEnd(event),
    // A date-only listing has no real time, so it goes on the calendar as a
    // whole day instead of at whatever hour the officer happened to store.
    allDay: event.reminder ? { start: day, end: addDays(day, 1) } : undefined,
  };
}

/**
 * The public calendar as an iCalendar feed: everything upcoming plus the last
 * `FEED_PAST_DAYS` days, soonest first. `now` is passed in so the same input
 * always gives the same bytes.
 */
export function eventsCalendar(events: readonly FeedEvent[], now: Date) {
  const since = now.getTime() - FEED_PAST_DAYS * 24 * 60 * 60 * 1000;
  const shown = events
    .filter((event) => event.startsAt.getTime() >= since)
    .sort(
      (a, b) =>
        a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id),
    );
  return buildCalendar({
    productId: "-//GT SASE//Buzz Events//EN",
    name: `${site.name} events`,
    description: `Public events from ${site.name}. Details and RSVP at ${site.url}/events.`,
    refreshHours: REFRESH_HOURS,
    events: shown.map(toCalendarEvent),
  });
}
