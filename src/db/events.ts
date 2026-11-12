import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import {
  callFunction,
  capped,
  changedRow,
  firstRow,
  nullAsNotFound,
  query,
  sql,
} from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import type { CappedList, EventChoice, EventRow } from "./types.ts";
import {
  MAX_EVENT_NAME_LENGTH,
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
/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

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
      sql`insert into events (guild_id, channel_id, name, event_date, created_by)
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
      sql`insert into events
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
      sql`select ${EVENT_COLUMNS} from events
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
    sql`select ${EVENT_COLUMNS} from events
      where guild_id = ${guildId} and channel_id = ${channelId} and name = ${name}
        and event_date = ${eventDate} and deleted_at is null
      order by id limit ${MAX_CHOICES}`,
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
      sql`select ${EVENT_COLUMNS} from events
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
    sql`select ${EVENT_CHOICE_COLUMNS} from events
      where guild_id = ${guildId} and deleted_at is null
        and name ilike ${searchPattern(term)}
      order by status, event_date desc, id limit ${MAX_CHOICES}`,
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
      sql`update events set thread_id = ${key.threadId}, thread_status = 'active'
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
      sql`update events set thread_id = ${key.threadId},
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
      sql`update events set thread_status = 'missing'
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
      sql`update events set overview_message_id = ${key.messageId}
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
      sql`update events set status = 'closed'
      where id = ${key.eventId} and guild_id = ${key.guildId} and deleted_at is null
        and status = 'active'
      returning ${EVENT_COLUMNS}`,
    ),
  );
}

/**
 * Reserves the right to create this pending event's post. False if it is no longer
 * pending, or if another attempt began in the last 60 seconds.
 */
export async function claimEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.claim_event_post_attempt(p_event_id => ${key.eventId},
      p_guild_id => ${key.guildId}) as value`,
  );
}

/** Gives the reservation back. Only after Discord clearly refused to make the post. */
export async function releaseEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.release_event_post_attempt(p_event_id => ${key.eventId},
      p_guild_id => ${key.guildId}) as value`,
  );
}

/** Soft-deletes the event and its tasks. Returns how many tasks were deleted. */
export async function softDeleteEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<number>> {
  // The function returns null when there is no live event with that ID in that guild.
  return nullAsNotFound(
    await callFunction<number | null>(
      db,
      sql`select public.soft_delete_event(p_event_id => ${key.eventId},
        p_guild_id => ${key.guildId}) as value`,
    ),
  );
}
