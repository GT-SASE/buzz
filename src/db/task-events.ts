/** What the task commands read about events: the post they run in, and the picker. */

import type { DbClient } from "./client.ts";
import { EVENT_CHOICE_COLUMNS, EVENT_COLUMNS } from "./events.ts";
import { firstRow, query, sql } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import type { EventChoice, EventRow } from "./types.ts";
import { idPrefixRange, isSearchTerm, searchPattern } from "./validate.ts";

/** Discord's limit for autocomplete choices. */
const MAX_CHOICES = 25;

/** The live event a thread belongs to in this guild, whether open or closed. */
export async function findEventByThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  return firstRow(
    await query<EventRow>(
      db,
      sql`select ${EVENT_COLUMNS} from events
      where thread_id = ${threadId} and guild_id = ${guildId} and deleted_at is null
      limit 1`,
    ),
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
  return firstRow(
    await query<EventRow>(
      db,
      sql`select ${EVENT_COLUMNS} from events
      where thread_id = ${threadId} and guild_id = ${guildId} limit 1`,
    ),
  );
}

/** Autocomplete by the start of an event's ID, across events that can take tasks. */
export async function searchOpenEventsByIdPrefix(
  db: DbClient,
  { guildId, prefix }: { guildId: string; prefix: string },
): Promise<DbResult<EventChoice[]>> {
  const { low, high } = idPrefixRange(prefix);
  return await query<EventChoice>(
    db,
    sql`select ${EVENT_CHOICE_COLUMNS} from events
      where guild_id = ${guildId} and status = 'active' and deleted_at is null
        and id >= ${low} and id <= ${high}
      order by id limit ${MAX_CHOICES}`,
  );
}

/**
 * Autocomplete across the events a task can still be added to, latest date first. Nothing
 * closes a past event by itself, so the oldest first would crowd out the current ones.
 */
export async function searchOpenEvents(
  db: DbClient,
  { guildId, term }: { guildId: string; term: string },
): Promise<DbResult<EventChoice[]>> {
  if (!isSearchTerm(term)) {
    return refused();
  }
  return await query<EventChoice>(
    db,
    sql`select ${EVENT_CHOICE_COLUMNS} from events
      where guild_id = ${guildId} and status = 'active' and deleted_at is null
        and name ilike ${searchPattern(term)}
      order by event_date desc, id limit ${MAX_CHOICES}`,
  );
}
