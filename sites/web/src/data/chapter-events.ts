import "server-only";

import { unstable_cache } from "next/cache";
import { and, asc, desc, gte, isNull, lt } from "drizzle-orm";

import { db, events } from "@buzz/db";

export const CHAPTER_EVENTS_TAG = "chapter-events";

/**
 * The live chapter calendar. Upcoming rows (and the ones that just wrapped)
 * come from the same table the officer tools write to. Years of Engage history
 * do not — that archive is static, in `past-events.ts`, so this table stays
 * the one members can still check into.
 */
export type PublicEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  displayDate: string;
  /** Campus-wide listing SASE did not host. Still on /events, not "next up". */
  reminder: boolean;
};

type StoredEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  displayDate: string;
  reminder: boolean;
};

const ZONE = "America/New_York";

const dayAndTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: ZONE,
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: ZONE,
});

/** An event stays on the calendar until it is a day old, then moves to past. */
const SETTLE_MS = 24 * 60 * 60 * 1000;

/**
 * "Recently wrapped" on the public page is this year's portal calendar, not
 * whatever leftover rows happen to sit in the table. History before that is
 * the static archive.
 */
const LIVE_CALENDAR_START = new Date("2026-08-01T00:00:00-04:00");
const columns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startsAt: events.startsAt,
  pointsValue: events.pointsValue,
  checkInEnabled: events.checkInEnabled,
  // checkInCode is deliberately absent. It is a bearer credential, and this is
  // the one query whose output reaches an unauthenticated page.
} as const;

function toStored(row: {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  pointsValue: number;
  checkInEnabled: boolean;
}): StoredEvent {
  const reminder = row.pointsValue === 0 && !row.checkInEnabled;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    location: row.location,
    startsAt: row.startsAt.toISOString(),
    displayDate: (reminder ? dateOnly : dayAndTime).format(row.startsAt),
    reminder,
  };
}

const revive = (row: StoredEvent): PublicEvent => ({
  ...row,
  startsAt: new Date(row.startsAt),
});

type CalendarPayload = { upcoming: StoredEvent[]; past: StoredEvent[] };

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
        .limit(80),
      db
        .select(columns)
        .from(events)
        .where(
          and(
            isNull(events.archivedAt),
            lt(events.startsAt, cutoff),
            gte(events.startsAt, LIVE_CALENDAR_START),
          ),
        )
        .orderBy(desc(events.startsAt))
        .limit(24),
    ]);

    return {
      upcoming: upcoming.map(toStored),
      past: past.map(toStored),
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

/** Matches the homepage/events ISR in production. `next dev` ignores page
 * `revalidate`, so keep a short data-cache life there. */
const loadChapterEvents = unstable_cache(
  fetchChapterEvents,
  [CHAPTER_EVENTS_TAG],
  {
    tags: [CHAPTER_EVENTS_TAG],
    revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
  },
);

export async function getChapterEvents() {
  const payload = await loadChapterEvents();
  return {
    upcoming: payload.upcoming.map(revive),
    past: payload.past.map(revive),
  };
}
