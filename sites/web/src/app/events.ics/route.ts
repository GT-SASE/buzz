import { getChapterCalendar } from "~/data/chapter-events";
import { eventsCalendar } from "~/lib/events-feed";

// Prerendered and refreshed hourly with the pages, and by the same officer
// writes: see revalidate-calendar.ts.
export const dynamic = "force-static";
export const revalidate = 3600;

/**
 * The public calendar as a subscribable iCalendar feed.
 *
 * Reads the strict calendar, not the one the pages use: that one answers a
 * database error with an empty list, and an empty feed would tell every
 * subscriber's calendar that all of these events were cancelled. A failure
 * here leaves the last good copy in place instead.
 */
export async function GET() {
  const { upcoming, past } = await getChapterCalendar();
  return new Response(eventsCalendar([...upcoming, ...past], new Date()), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="gt-sase-events.ics"',
    },
  });
}
