import "server-only";

import { and, asc, desc, gte, isNull, lt } from "drizzle-orm";

import { db, events } from "@buzz/db";

/**
 * The public calendar, read from the same table the officer tools write to.
 *
 * Until now `/events` rendered a hardcoded array, so publishing an event meant
 * editing source and redeploying while the portal already held the real one.
 * This is the join between the two halves of the site.
 */
type PublicEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  displayDate: string;
};

const dayAndTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

/** An event stays on the calendar until it is a day old, then moves to past. */
const SETTLE_MS = 24 * 60 * 60 * 1000;

const columns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startsAt: events.startsAt,
  // checkInCode is deliberately absent. It is a bearer credential, and this is
  // the one query whose output reaches an unauthenticated page.
} as const;

const withDisplayDate = (row: Omit<PublicEvent, "displayDate">) => ({
  ...row,
  displayDate: dayAndTime.format(row.startsAt),
});

export async function getChapterEvents() {
  const cutoff = new Date(Date.now() - SETTLE_MS);

  // The public site is required to build with no environment at all. That is
  // the ONLY case an empty calendar is the right answer for.
  if (!process.env.DATABASE_URL) return { upcoming: [], past: [] };

  try {
    // Two queries, each bounded from now, rather than one ascending window over
    // the whole table. A single `order by starts_at asc limit n` returns the
    // EARLIEST rows, so once the chapter has more than n unarchived events the
    // limit is consumed entirely by history and newly published events stop
    // appearing — silently, with an empty calendar and no error anywhere.
    const [upcoming, past] = await Promise.all([
      db
        .select(columns)
        .from(events)
        .where(and(isNull(events.archivedAt), gte(events.startsAt, cutoff)))
        .orderBy(asc(events.startsAt))
        .limit(50),
      db
        .select(columns)
        .from(events)
        .where(and(isNull(events.archivedAt), lt(events.startsAt, cutoff)))
        .orderBy(desc(events.startsAt))
        .limit(24),
    ]);

    return {
      upcoming: upcoming.map(withDisplayDate),
      past: past.map(withDisplayDate),
    };
  } catch (error) {
    // Prefer an empty calendar over the unstyled Next error page on a cold
    // render. Marketing routes catch this at the segment boundary too, but
    // returning here keeps the homepage and /events themselves green.
    console.error(
      JSON.stringify({
        level: "error",
        event: "chapter.calendar",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
    );
    return { upcoming: [], past: [] };
  }
}
