import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import { and, asc, eq, isNull, sql as dsql } from "drizzle-orm";
import type { DbClient } from "./client.ts";
import {
  capped,
  changedRow,
  firstRow,
  nullAsNotFound,
  query,
  sql,
  transact,
  write,
} from "./internal.ts";
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
export const EVENT_COLUMNS = sql`id, guild_id, channel_id, name, event_date, thread_id,
  overview_message_id, status, thread_status, created_by, deleted_at, created_at`;

/** The columns of an `EventChoice`. */
export const EVENT_CHOICE_COLUMNS = sql`id, name, event_date, status`;

const MAX_EVENTS = 100;

export interface EventKey {
  guildId: string;
  eventId: string;
}

function isEventKey({ guildId, eventId }: EventKey): boolean {
  return isSnowflake(guildId) && isUuid(eventId);
}

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
    await query<EventRow>(
      db,
      sql`insert into discord_bot.events (guild_id, channel_id, name, event_date, created_by)
      values (${guildId}, ${channelId}, ${name}, ${eventDate}, ${actorId})
      returning ${EVENT_COLUMNS}`,
    ),
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
    await query<EventRow>(
      db,
      sql`insert into discord_bot.events
        (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
      values (${guildId}, ${channelId}, ${name}, ${eventDate}, ${actorId}, ${threadId},
        'active')
      returning ${EVENT_COLUMNS}`,
    ),
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
    await query<EventRow>(
      db,
      sql`select ${EVENT_COLUMNS} from discord_bot.events
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
      limit 1`,
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
  return await query<EventRow>(
    db,
    sql`select ${EVENT_COLUMNS} from discord_bot.events
      where guild_id = ${guildId} and channel_id = ${channelId} and name = ${name}
        and event_date = ${eventDate} and deleted_at is null
      order by id limit ${DISCORD_LIMITS.autocompleteChoices}`,
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
    await query<EventRow>(
      db,
      sql`select ${EVENT_COLUMNS} from discord_bot.events
      where guild_id = ${guildId} and deleted_at is null
      order by status, event_date desc, id limit ${MAX_EVENTS + 1}`,
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
  return await query<EventChoice>(
    db,
    sql`select ${EVENT_CHOICE_COLUMNS} from discord_bot.events
      where guild_id = ${guildId} and deleted_at is null
        and name ilike ${searchPattern(term)}
      order by status, event_date desc, id limit ${DISCORD_LIMITS.autocompleteChoices}`,
  );
}

/** Autocomplete by the start of an event's ID, across live events of any status. */
export async function searchEventsByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<EventChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return await query<EventChoice>(
    db,
    sql`select ${EVENT_CHOICE_COLUMNS} from discord_bot.events
      where guild_id = ${guildId} and deleted_at is null
        and id >= ${low} and id <= ${high}
      order by id limit ${DISCORD_LIMITS.autocompleteChoices}`,
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
  return changedRow(
    await query<EventRow>(
      db,
      sql`update discord_bot.events set thread_id = ${key.threadId}, thread_status = 'active'
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
        and thread_status <> 'active'
      returning ${EVENT_COLUMNS}`,
    ),
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
  return changedRow(
    await query<EventRow>(
      db,
      sql`update discord_bot.events set thread_id = ${key.threadId},
        overview_message_id = ${key.overviewMessageId}, thread_status = 'active'
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
        and thread_status = 'pending'
      returning ${EVENT_COLUMNS}`,
    ),
  );
}

export async function markEventThreadMissing(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  return changedRow(
    await query<EventRow>(
      db,
      sql`update discord_bot.events set thread_status = 'missing'
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
        and thread_status = 'active'
      returning ${EVENT_COLUMNS}`,
    ),
  );
}

export async function setEventOverviewMessage(
  db: DbClient,
  key: EventKey & { messageId: string },
): Promise<DbResult<EventRow>> {
  return changedRow(
    await query<EventRow>(
      db,
      sql`update discord_bot.events set overview_message_id = ${key.messageId}
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
      returning ${EVENT_COLUMNS}`,
    ),
  );
}

/** Closes an active event. A second close fails as `not_found`. */
export async function closeEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  return changedRow(
    await query<EventRow>(
      db,
      sql`update discord_bot.events set status = 'closed'
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
        and status = 'active'
      returning ${EVENT_COLUMNS}`,
    ),
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
  return write(db, async (orm) => {
    const claimed = await orm
      .update(events)
      .set({ postAttemptAt: dsql`now()` })
      .where(
        and(
          eq(events.id, key.eventId),
          eq(events.guildId, key.guildId),
          isNull(events.deletedAt),
          eq(events.threadStatus, "pending"),
          isNull(events.postAttemptAt),
        ),
      )
      .returning({ id: events.id });
    return claimed.length > 0;
  });
}

/** Gives the reservation back. Only after Discord clearly refused to make the post. */
export async function releaseEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  return write(db, async (orm) => {
    const released = await orm
      .update(events)
      .set({ postAttemptAt: null })
      .where(
        and(
          eq(events.id, key.eventId),
          eq(events.guildId, key.guildId),
          isNull(events.deletedAt),
          eq(events.threadStatus, "pending"),
        ),
      )
      .returning({ id: events.id });
    return released.length > 0;
  });
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

      const deleted = await tx
        .update(events)
        .set({ deletedAt: dsql`now()` })
        .where(
          and(
            eq(events.id, key.eventId),
            eq(events.guildId, key.guildId),
            isNull(events.deletedAt),
          ),
        )
        .returning({ id: events.id });
      if (deleted.length === 0) {
        return null;
      }

      const deletedTasks = await tx
        .update(tasks)
        .set({ deletedAt: dsql`now()` })
        .where(and(eq(tasks.eventId, key.eventId), isNull(tasks.deletedAt)))
        .returning({ id: tasks.id });
      return deletedTasks.length;
    }),
  );
}
