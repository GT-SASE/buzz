import { and, asc, desc, eq, gte, ilike, isNull, lte, sql } from "drizzle-orm";
import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { updateRecorded } from "./history.ts";
import {
  capped,
  changedRow,
  firstRow,
  nullAsNotFound,
  read,
  transact,
} from "./internal.ts";
import { makeSteps, requireLiveChannel } from "./rules.ts";
import { events, tasks } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import type { CappedList, EventChoice, EventRow } from "./types.ts";
import {
  MAX_EVENT_NAME_LENGTH,
  idPrefixRange,
  isDbDate,
  isSearchTerm,
  isStoredText,
  isUuid,
  searchPattern,
} from "./validate.ts";

/** The columns of an `EventRow`. */
export const EVENT_ROW = {
  id: events.id,
  guild_id: events.guildId,
  channel_id: events.channelId,
  name: events.name,
  event_date: events.eventDate,
  thread_id: events.threadId,
  overview_message_id: events.overviewMessageId,
  status: events.status,
  thread_status: events.threadStatus,
  created_by: events.createdBy,
  deleted_at: events.deletedAt,
  created_at: events.createdAt,
};

/** The columns of an `EventChoice`. */
export const EVENT_CHOICE = {
  id: events.id,
  name: events.name,
  event_date: events.eventDate,
  status: events.status,
};

const MAX_EVENTS = 100;

export interface EventKey {
  guildId: string;
  eventId: string;
}

function isEventKey({ guildId, eventId }: EventKey): boolean {
  return isSnowflake(guildId) && isUuid(eventId);
}

/** An event that is live, in this guild, and has this ID. */
const liveEvent = (key: EventKey) =>
  and(
    eq(events.id, key.eventId),
    eq(events.guildId, key.guildId),
    isNull(events.deletedAt),
  );

export interface NewEvent {
  guildId: string;
  channelId: string;
  actorId: string;
  name: string;
  eventDate: DateOnly;
}

/**
 * Fails as `parent_unavailable` if the channel has been removed, and as `conflict` if
 * this officer already has the same event waiting for its post.
 */
export async function createEvent(
  db: DbClient,
  { guildId, channelId, actorId, name, eventDate }: NewEvent,
): Promise<DbResult<EventRow>> {
  if (!isStoredText(name, MAX_EVENT_NAME_LENGTH) || !isDbDate(eventDate)) {
    return refused();
  }
  return changedRow(
    await transact(db, async (tx) => {
      await requireLiveChannel(tx, guildId, channelId);
      const created = await tx
        .insert(events)
        .values({ guildId, channelId, name, eventDate, createdBy: actorId })
        .returning(EVENT_ROW);
      for (const event of created) {
        await makeSteps(tx, { id: event.id, guildId });
      }
      return created as EventRow[];
    }),
  );
}

export interface NewLinkedEvent extends NewEvent {
  threadId: string;
}

/**
 * An event that starts out attached to an existing post, in one write. Fails as
 * `conflict` if another live event already holds the thread, and as
 * `parent_unavailable` if the channel has been removed.
 */
export async function createLinkedEvent(
  db: DbClient,
  { guildId, channelId, actorId, name, eventDate, threadId }: NewLinkedEvent,
): Promise<DbResult<EventRow>> {
  if (!isStoredText(name, MAX_EVENT_NAME_LENGTH) || !isDbDate(eventDate)) {
    return refused();
  }
  return changedRow(
    await transact(db, async (tx) => {
      await requireLiveChannel(tx, guildId, channelId);
      const created = await tx
        .insert(events)
        .values({
          guildId,
          channelId,
          name,
          eventDate,
          createdBy: actorId,
          threadId,
          threadStatus: "active",
        })
        .returning(EVENT_ROW);
      for (const event of created) {
        await makeSteps(tx, { id: event.id, guildId });
      }
      return created as EventRow[];
    }),
  );
}

/** A live event in this guild. An ID from another guild looks like an unknown ID. */
export async function getEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow | null>> {
  if (!isEventKey(key)) {
    return refused();
  }
  return firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select(EVENT_ROW)
          .from(events)
          .where(liveEvent(key))
          .limit(1) as unknown as Promise<EventRow[]>,
    ),
  );
}

/** Live events with exactly this name and date in one forum, oldest ID first. */
export async function listEventsNamed(
  db: DbClient,
  { guildId, channelId, name, eventDate }: Omit<NewEvent, "actorId">,
): Promise<DbResult<EventRow[]>> {
  if (!isStoredText(name, MAX_EVENT_NAME_LENGTH) || !isDbDate(eventDate)) {
    return refused();
  }
  return read(
    db,
    (orm) =>
      orm
        .select(EVENT_ROW)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.channelId, channelId),
            eq(events.name, name),
            eq(events.eventDate, eventDate),
            isNull(events.deletedAt),
          ),
        )
        .orderBy(asc(events.id))
        .limit(DISCORD_LIMITS.autocompleteChoices) as unknown as Promise<
        EventRow[]
      >,
  );
}

/**
 * Active events come first, then the latest date. The list is capped, so this decides
 * what is left out: never a live event in favour of a hundred finished ones.
 */
export async function listEvents(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<EventRow>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select(EVENT_ROW)
          .from(events)
          .where(and(eq(events.guildId, guildId), isNull(events.deletedAt)))
          .orderBy(asc(events.status), desc(events.eventDate), asc(events.id))
          .limit(MAX_EVENTS + 1) as unknown as Promise<EventRow[]>,
    ),
    MAX_EVENTS,
  );
}

/**
 * Autocomplete on the name, with active events and the latest dates first. The term
 * only ever matches literally. The guild is found by index, but `%term%` cannot use one
 * for the name, so a search reads all of one guild's live events to find 25.
 */
export async function searchEvents(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<EventChoice[]>> {
  if (!isSearchTerm(term)) {
    return refused();
  }
  return read(
    db,
    (orm) =>
      orm
        .select(EVENT_CHOICE)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            isNull(events.deletedAt),
            ilike(events.name, searchPattern(term)),
          ),
        )
        .orderBy(asc(events.status), desc(events.eventDate), asc(events.id))
        .limit(DISCORD_LIMITS.autocompleteChoices) as unknown as Promise<
        EventChoice[]
      >,
  );
}

/** Autocomplete by the start of an event's ID, across live events of any status. */
export async function searchEventsByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<EventChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return read(
    db,
    (orm) =>
      orm
        .select(EVENT_CHOICE)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            isNull(events.deletedAt),
            gte(events.id, low),
            lte(events.id, high),
          ),
        )
        .orderBy(asc(events.id))
        .limit(DISCORD_LIMITS.autocompleteChoices) as unknown as Promise<
        EventChoice[]
      >,
  );
}

/** Changes the live event `key` names, if `also` holds, and returns it. */
async function changeEvent(
  db: DbClient,
  key: EventKey,
  set: Record<string, unknown>,
  also: ReturnType<typeof and>,
): Promise<DbResult<EventRow>> {
  return changedRow(
    await transact(
      db,
      async (tx) =>
        (await updateRecorded(
          tx,
          events,
          set,
          and(liveEvent(key), also),
          EVENT_ROW,
        )) as unknown as EventRow[],
    ),
  );
}

/**
 * Links a thread to an event that has none, or whose thread has gone missing. Fails
 * as `conflict` if another live event already holds the thread.
 */
export async function setEventThread(
  db: DbClient,
  key: EventKey & { threadId: string },
): Promise<DbResult<EventRow>> {
  return changeEvent(
    db,
    key,
    { threadId: key.threadId, threadStatus: "active" },
    sql`${events.threadStatus} <> 'active'`,
  );
}

/**
 * Records a new post and its overview message on a pending event, in one write, so
 * no reader sees a post without its overview. Fails as `not_found` if the event is no
 * longer pending, and as `conflict` if another live event holds the thread.
 */
export async function attachEventPost(
  db: DbClient,
  key: EventKey & { threadId: string; overviewMessageId: string },
): Promise<DbResult<EventRow>> {
  return changeEvent(
    db,
    key,
    {
      threadId: key.threadId,
      overviewMessageId: key.overviewMessageId,
      threadStatus: "active",
    },
    eq(events.threadStatus, "pending"),
  );
}

export async function markEventThreadMissing(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  return changeEvent(
    db,
    key,
    { threadStatus: "missing" },
    eq(events.threadStatus, "active"),
  );
}

export async function setEventOverviewMessage(
  db: DbClient,
  key: EventKey & { messageId: string },
): Promise<DbResult<EventRow>> {
  return changeEvent(db, key, { overviewMessageId: key.messageId }, undefined);
}

/** Closes an active event. A second close fails as `not_found`. */
export async function closeEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  return changeEvent(
    db,
    key,
    { status: "closed" },
    eq(events.status, "active"),
  );
}

/**
 * Reserves the right to create this pending event's post. False if it is no longer
 * pending, or if an earlier attempt holds it: an attempt is only given back after
 * Discord clearly refused the post.
 */
export async function claimEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  const claimed = await transact(db, (tx) =>
    updateRecorded(
      tx,
      events,
      { postAttemptAt: sql`now()` },
      and(
        liveEvent(key),
        eq(events.threadStatus, "pending"),
        isNull(events.postAttemptAt),
      ),
      { id: events.id },
    ),
  );
  return claimed.ok ? { ok: true, value: claimed.value.length > 0 } : claimed;
}

/** Gives the reservation back. Only after Discord clearly refused to make the post. */
export async function releaseEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  const released = await transact(db, (tx) =>
    updateRecorded(
      tx,
      events,
      { postAttemptAt: null },
      and(liveEvent(key), eq(events.threadStatus, "pending")),
      { id: events.id },
    ),
  );
  return released.ok
    ? { ok: true, value: released.value.length > 0 }
    : released;
}

/** Soft-deletes the event and its tasks. Returns how many tasks were deleted. */
export async function softDeleteEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<number>> {
  // Null when there is no live event with that ID in that guild.
  return nullAsNotFound(
    await transact(db, async (tx) => {
      // The event's tasks are locked first, in a fixed order, so two deletes of the same
      // event, or a delete and an edit, wait on each other and cannot deadlock.
      await tx
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.eventId, key.eventId),
            eq(tasks.guildId, key.guildId),
            isNull(tasks.deletedAt),
          ),
        )
        .orderBy(asc(tasks.id))
        .for("no key update");

      const deleted = await updateRecorded(
        tx,
        events,
        { deletedAt: sql`now()` },
        liveEvent(key),
        { id: events.id },
      );
      if (deleted.length === 0) {
        return null;
      }

      const deletedTasks = await updateRecorded(
        tx,
        tasks,
        { deletedAt: sql`now()` },
        and(eq(tasks.eventId, key.eventId), isNull(tasks.deletedAt)),
        { id: tasks.id },
      );
      return deletedTasks.length;
    }),
  );
}
