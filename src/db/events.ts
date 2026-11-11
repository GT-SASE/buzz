import type { DateOnly } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  booleanValue,
  cappedList,
  exactlyOne,
  integerValue,
  oneOrNone,
  rowList,
  type CappedList,
  type RowList,
} from "./result.ts";
import {
  parseEvent,
  parseEventChoice,
  type EventChoice,
  type EventRow,
} from "./types.ts";
import {
  MAX_EVENT_NAME_LENGTH,
  isDbDate,
  isSearchTerm,
  isStoredText,
  isUuid,
  searchPattern,
} from "./validate.ts";

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

/** Fails as `parent_unavailable` if the channel has been removed. */
export async function createEvent(
  db: DbClient,
  { guildId, channelId, actorId, name, eventDate }: NewEvent,
): Promise<DbResult<EventRow>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(channelId) ||
    !isSnowflake(actorId) ||
    !isStoredText(name, MAX_EVENT_NAME_LENGTH) ||
    !isDbDate(eventDate)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .insert({
        guild_id: guildId,
        channel_id: channelId,
        name,
        event_date: eventDate,
        created_by: actorId,
      })
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
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
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(channelId) ||
    !isSnowflake(actorId) ||
    !isSnowflake(threadId) ||
    !isStoredText(name, MAX_EVENT_NAME_LENGTH) ||
    !isDbDate(eventDate)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .insert({
        guild_id: guildId,
        channel_id: channelId,
        name,
        event_date: eventDate,
        created_by: actorId,
        thread_id: threadId,
        thread_status: "active",
      })
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
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
  return oneOrNone(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .limit(1),
    parseEvent,
  );
}

/** Live events with exactly this name and date in one forum, oldest ID first. */
export async function listEventsNamed(
  db: DbClient,
  { guildId, channelId, name, eventDate }: Omit<NewEvent, "actorId">,
): Promise<DbResult<RowList<EventRow>>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(channelId) ||
    !isStoredText(name, MAX_EVENT_NAME_LENGTH) ||
    !isDbDate(eventDate)
  ) {
    return refused();
  }
  return rowList(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("guild_id", guildId)
      .eq("channel_id", channelId)
      .eq("name", name)
      .eq("event_date", eventDate)
      .is("deleted_at", null)
      .order("id")
      .limit(MAX_CHOICES),
    parseEvent,
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
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("guild_id", guildId)
      .is("deleted_at", null)
      .order("status")
      .order("event_date", { ascending: false })
      .order("id")
      .limit(MAX_EVENTS + 1),
    parseEvent,
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
): Promise<DbResult<RowList<EventChoice>>> {
  if (!isSnowflake(guildId) || !isSearchTerm(term)) {
    return refused();
  }
  return rowList(
    await rest(db)
      .from("events")
      .select("id,name,event_date,status")
      .eq("guild_id", guildId)
      .is("deleted_at", null)
      .ilike("name", searchPattern(term))
      .order("status")
      .order("event_date", { ascending: false })
      .order("id")
      .limit(MAX_CHOICES),
    parseEventChoice,
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
  if (!isEventKey(key) || !isSnowflake(key.threadId)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .update({ thread_id: key.threadId, thread_status: "active" })
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .neq("thread_status", "active")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
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
  if (
    !isEventKey(key) ||
    !isSnowflake(key.threadId) ||
    !isSnowflake(key.overviewMessageId)
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .update({
        thread_id: key.threadId,
        overview_message_id: key.overviewMessageId,
        thread_status: "active",
      })
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .eq("thread_status", "pending")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
  );
}

export async function markEventThreadMissing(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  if (!isEventKey(key)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .update({ thread_status: "missing" })
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .eq("thread_status", "active")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
  );
}

export async function setEventOverviewMessage(
  db: DbClient,
  key: EventKey & { messageId: string },
): Promise<DbResult<EventRow>> {
  if (!isEventKey(key) || !isSnowflake(key.messageId)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .update({ overview_message_id: key.messageId })
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
  );
}

/** Closes an active event. A second close fails as `not_found`. */
export async function closeEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<EventRow>> {
  if (!isEventKey(key)) {
    return refused();
  }
  return exactlyOne(
    await rest(db)
      .from("events")
      .update({ status: "closed" })
      .eq("id", key.eventId)
      .eq("guild_id", key.guildId)
      .is("deleted_at", null)
      .eq("status", "active")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      ),
    parseEvent,
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
  if (!isEventKey(key)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("claim_event_post_attempt", {
      p_event_id: key.eventId,
      p_guild_id: key.guildId,
    }),
  );
}

/** Gives the reservation back. Only after Discord clearly refused to make the post. */
export async function releaseEventPostAttempt(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<boolean>> {
  if (!isEventKey(key)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("release_event_post_attempt", {
      p_event_id: key.eventId,
      p_guild_id: key.guildId,
    }),
  );
}

/** Soft-deletes the event and its tasks. Returns how many tasks were deleted. */
export async function softDeleteEvent(
  db: DbClient,
  key: EventKey,
): Promise<DbResult<number>> {
  if (!isEventKey(key)) {
    return refused();
  }
  const response = await rest(db).rpc("soft_delete_event", {
    p_event_id: key.eventId,
    p_guild_id: key.guildId,
  });
  // The function returns null when there is no live event with that ID in that guild.
  if (response.error === null && response.data === null) {
    return failure("not_found");
  }
  return integerValue(response);
}
