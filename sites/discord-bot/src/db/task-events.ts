/** What the task commands read about events: the post they run in, and the picker. */

import { and, asc, desc, eq, gte, ilike, isNull, lte } from "drizzle-orm";
import { DISCORD_LIMITS } from "../discord/safe-text.ts";
import type { DbClient } from "./client.ts";
import { EVENT_CHOICE, EVENT_ROW } from "./events.ts";
import { firstRow, read } from "./internal.ts";
import { events } from "./schema.ts";
import { refused, type DbResult } from "./errors.ts";
import type { EventChoice, EventRow } from "./types.ts";
import { idPrefixRange, isSearchTerm, searchPattern } from "./validate.ts";

/** The live event a thread belongs to in this guild, whether open or closed. */
export async function findEventByThread(
  db: DbClient,
  { guildId, threadId }: { guildId: string; threadId: string },
): Promise<DbResult<EventRow | null>> {
  return firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select(EVENT_ROW)
          .from(events)
          .where(
            and(
              eq(events.threadId, threadId),
              eq(events.guildId, guildId),
              isNull(events.deletedAt),
            ),
          )
          .limit(1) as unknown as Promise<EventRow[]>,
    ),
  );
}

/** Autocomplete by the start of an event's ID, across events that can take tasks. */
export async function searchOpenEventsByIdPrefix(
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
            eq(events.status, "active"),
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
  return read(
    db,
    (orm) =>
      orm
        .select(EVENT_CHOICE)
        .from(events)
        .where(
          and(
            eq(events.guildId, guildId),
            eq(events.status, "active"),
            isNull(events.deletedAt),
            ilike(events.name, searchPattern(term)),
          ),
        )
        .orderBy(desc(events.eventDate), asc(events.id))
        .limit(DISCORD_LIMITS.autocompleteChoices) as unknown as Promise<
        EventChoice[]
      >,
  );
}
