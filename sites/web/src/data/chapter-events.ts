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

type StoredEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
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

/** `next dev` ignores page `revalidate`, so this is what stops a Postgres
 * round-trip on every homepage refresh. Production ISR still caches the HTML. */
const CALENDAR_TTL_MS = 60_000;

const columns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startsAt: events.startsAt,
  // checkInCode is deliberately absent. It is a bearer credential, and this is
  // the one query whose output reaches an unauthenticated page.
} as const;

const revive = (row: StoredEvent): PublicEvent => {
  const startsAt = new Date(row.startsAt);
  return {
    ...row,
    startsAt,
    displayDate: dayAndTime.format(startsAt),
  };
};

type CalendarPayload = { upcoming: StoredEvent[]; past: StoredEvent[] };

const globalForCalendar = globalThis as unknown as {
  chapterEvents: { expiresAt: number; payload: CalendarPayload } | undefined;
};

async function fetchChapterEvents(): Promise<CalendarPayload> {
  if (!process.env.DATABASE_URL) return { upcoming: [], past: [] };

  const cutoff = new Date(Date.now() - SETTLE_MS);

  try {
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
      upcoming: upcoming.map((row) => ({
        ...row,
        startsAt: row.startsAt.toISOString(),
      })),
      past: past.map((row) => ({
        ...row,
        startsAt: row.startsAt.toISOString(),
      })),
    };
  } catch (error) {
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

export async function getChapterEvents() {
  const now = Date.now();
  const memo = globalForCalendar.chapterEvents;
  if (memo && now < memo.expiresAt) {
    return {
      upcoming: memo.payload.upcoming.map(revive),
      past: memo.payload.past.map(revive),
    };
  }

  const payload = await fetchChapterEvents();
  globalForCalendar.chapterEvents = { expiresAt: now + CALENDAR_TTL_MS, payload };
  return {
    upcoming: payload.upcoming.map(revive),
    past: payload.past.map(revive),
  };
}
