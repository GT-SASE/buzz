import "server-only";

import { unstable_cache } from "next/cache";
import { and, asc, desc, eq, gte, isNull, lt } from "drizzle-orm";

import { db, events } from "@buzz/db";

import { CHAPTER_ZONE, EVENT_SETTLE_MS } from "~/lib/event-time";

export const CHAPTER_EVENTS_TAG = "chapter-events";

/**
 * The public calendar. Every row comes from the same table the officer tools
 * write to. Archived events stay off the site; check-in codes never leave
 * this query.
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
  /** When an officer last wrote the row. Stable between edits. */
  modifiedAt: Date;
};

type StoredEvent = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  displayDate: string;
  reminder: boolean;
  modifiedAt: string;
};

const dayAndTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: CHAPTER_ZONE,
});

const dateOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: CHAPTER_ZONE,
});

const columns = {
  id: events.id,
  title: events.title,
  description: events.description,
  location: events.location,
  startsAt: events.startsAt,
  pointsValue: events.pointsValue,
  checkInEnabled: events.checkInEnabled,
  createdAt: events.createdAt,
  updatedAt: events.updatedAt,
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
  createdAt: Date;
  updatedAt: Date | null;
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
    modifiedAt: (row.updatedAt ?? row.createdAt).toISOString(),
  };
}

const revive = (row: StoredEvent): PublicEvent => ({
  ...row,
  startsAt: new Date(row.startsAt),
  modifiedAt: new Date(row.modifiedAt),
});

type CalendarPayload = { upcoming: StoredEvent[]; past: StoredEvent[] };

// Throws on a database error: unstable_cache does not store a throw, so one
// transient failure is not served for the whole revalidate window.
async function fetchChapterEvents(): Promise<CalendarPayload> {
  if (!process.env.DATABASE_URL) return { upcoming: [], past: [] };

  const cutoff = new Date(Date.now() - EVENT_SETTLE_MS);

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
      .where(and(isNull(events.archivedAt), lt(events.startsAt, cutoff)))
      .orderBy(desc(events.startsAt))
      .limit(200),
  ]);

  return {
    upcoming: upcoming.map(toStored),
    past: past.map(toStored),
  };
}

// Throws on a database error, like the list above. A missing row is null.
async function fetchChapterEvent(id: string): Promise<StoredEvent | null> {
  if (!process.env.DATABASE_URL) return null;
  const [row] = await db
    .select(columns)
    .from(events)
    .where(and(eq(events.id, id), isNull(events.archivedAt)))
    .limit(1);
  return row ? toStored(row) : null;
}

/** Matches the homepage/events ISR in production. `next dev` ignores page
 * `revalidate`, so keep a short data-cache life there. The key carries a
 * version: the data cache outlives a deploy, and a payload read with the
 * wrong shape would break the page until it expired. */
const cacheOptions = {
  tags: [CHAPTER_EVENTS_TAG],
  revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
};

const loadChapterEvents = unstable_cache(
  fetchChapterEvents,
  [CHAPTER_EVENTS_TAG, "v2"],
  cacheOptions,
);

const loadChapterEvent = unstable_cache(
  fetchChapterEvent,
  [CHAPTER_EVENTS_TAG, "event", "v2"],
  cacheOptions,
);

/**
 * The calendar, or the database error. For routes whose output must not be
 * built from a failure: a feed that went out empty would wipe every
 * subscriber's calendar, and a static page that does not render keeps serving
 * its last good copy.
 */
export async function getChapterCalendar() {
  const payload = await loadChapterEvents();
  return {
    upcoming: payload.upcoming.map(revive),
    past: payload.past.map(revive),
  };
}

/** The calendar for pages that would rather show nothing than fail. */
export async function getChapterEvents() {
  try {
    return await getChapterCalendar();
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

/** Ids are UUIDs; anything that cannot be one never reaches the database. */
const EVENT_ID = /^[A-Za-z0-9_-]{1,255}$/;

/**
 * One public event by id, or null for an unknown id, an archived event, or no
 * database. Past events count: the archive lists them. Throws on a database
 * error rather than answering "not found", so a blip does not become a cached
 * 404.
 */
export async function getChapterEvent(id: string) {
  if (!EVENT_ID.test(id)) return null;
  // The list is already cached and holds nearly every event anyone links to.
  const { upcoming, past } = await getChapterCalendar();
  const listed = [...upcoming, ...past].find((event) => event.id === id);
  if (listed) return listed;
  const row = await loadChapterEvent(id);
  return row ? revive(row) : null;
}
