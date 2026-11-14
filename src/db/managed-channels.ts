import type { DbClient } from "./client.ts";
import { EVENT_COLUMNS } from "./events.ts";
import { callFunction, capped, firstRow, query, sql } from "./internal.ts";
import type { DbResult } from "./errors.ts";
import type { CappedList, EventRow, ManagedChannel } from "./types.ts";

const MAX_CHANNELS = 500;

export async function getManagedChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<ManagedChannel | null>> {
  return firstRow(
    await query<ManagedChannel>(
      db,
      sql`select guild_id, channel_id, status from managed_channels
      where guild_id = ${guildId} and channel_id = ${channelId} limit 1`,
    ),
  );
}

export async function listManagedChannels(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return capped(
    await query<ManagedChannel>(
      db,
      sql`select guild_id, channel_id, status from managed_channels
      where guild_id = ${guildId}
      order by channel_id limit ${MAX_CHANNELS + 1}`,
    ),
    MAX_CHANNELS,
  );
}

/** Every active channel of every guild, for the health check. */
export async function listActiveManagedChannels(
  db: DbClient,
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return capped(
    await query<ManagedChannel>(
      db,
      sql`select guild_id, channel_id, status from managed_channels
      where status = 'active'
      order by guild_id, channel_id limit ${MAX_CHANNELS + 1}`,
    ),
    MAX_CHANNELS,
  );
}

/** The given channels that this guild has a row for, whatever their status. */
export async function listManagedChannelsByIds(
  db: DbClient,
  { guildId, channelIds }: { guildId: string; channelIds: readonly string[] },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return capped(
    await query<ManagedChannel>(
      db,
      sql`select guild_id, channel_id, status from managed_channels
      where guild_id = ${guildId} and channel_id = any(${[...channelIds]}::text[])
      order by channel_id limit ${MAX_CHANNELS + 1}`,
    ),
    MAX_CHANNELS,
  );
}

/**
 * This channel's live events that have a post, open or closed, last changed first. For
 * redrawing posts when a forum is added back. `limit` is the most it returns.
 */
export async function listRecentEventsInChannel(
  db: DbClient,
  {
    guildId,
    channelId,
    limit,
  }: { guildId: string; channelId: string; limit: number },
): Promise<DbResult<CappedList<EventRow>>> {
  return capped(
    await query<EventRow>(
      db,
      sql`select ${EVENT_COLUMNS} from events
      where guild_id = ${guildId} and channel_id = ${channelId}
        and thread_status = 'active' and deleted_at is null
      order by updated_at desc, id limit ${limit + 1}`,
    ),
    limit,
  );
}

/** For the health check. False if the channel was not active, which is not a failure. */
export async function markChannelUnavailable(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<boolean>> {
  return callFunction<boolean>(
    db,
    sql`select public.mark_channel_unavailable(p_guild_id => ${guildId},
      p_channel_id => ${channelId}) as value`,
  );
}
