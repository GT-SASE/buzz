/** What the task commands read about events: the post they run in, and the picker. */

import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import { oneOrNone, rowList, type RowList } from "./result.ts";
import {
  parseEvent,
  parseEventChoice,
  type EventChoice,
  type EventRow,
} from "./types.ts";
import {
  idPrefixRange,
  isIdPrefix,
  isSearchTerm,
  searchPattern,
} from "./validate.ts";

/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

/** The live event a thread belongs to in this guild, whether open or closed. */
export async function findEventByThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(threadId)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("thread_id", threadId)
      .eq("guild_id", guildId)
      .is("deleted_at", null)
      .limit(1),
    parseEvent,
  );
}

/**
 * Any event this thread has belonged to and still names, live or soft-deleted. A deleted
 * event's post stays in the forum, so this tells it apart from a post nothing ever claimed.
 */
export async function findEventEverOnThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(threadId)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("thread_id", threadId)
      .eq("guild_id", guildId)
      .limit(1),
    parseEvent,
  );
}

/** Autocomplete by the start of an event's ID, across events that can take tasks. */
export async function searchOpenEventsByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<RowList<EventChoice>>> {
  if (!isSnowflake(guildId) || !isIdPrefix(prefix)) {
    return refused();
  }
  const { low, high } = idPrefixRange(prefix);
  return rowList(
    await rest(db)
      .from("events")
      .select("id,name,event_date,status")
      .eq("guild_id", guildId)
      .eq("status", "active")
      .is("deleted_at", null)
      .gte("id", low)
      .lte("id", high)
      .order("id")
      .limit(MAX_CHOICES),
    parseEventChoice,
  );
}

/**
 * Autocomplete across the events a task can still be added to, latest date first. Nothing
 * closes a past event by itself, so the oldest first would crowd out the current ones.
 */
export async function searchOpenEvents(
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
      .eq("status", "active")
      .is("deleted_at", null)
      .ilike("name", searchPattern(term))
      .order("event_date", { ascending: false })
      .order("id")
      .limit(MAX_CHOICES),
    parseEventChoice,
  );
}
