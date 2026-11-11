import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import {
  booleanValue,
  cappedList,
  oneOrNone,
  type CappedList,
} from "./result.ts";
import {
  parseEvent,
  parseManagedChannel,
  type EventRow,
  type ManagedChannel,
} from "./types.ts";
import { isSnowflakeList, snowflakeList } from "./validate.ts";

const MAX_CHANNELS = 500;

export async function getManagedChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<ManagedChannel | null>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("managed_channels")
      .select("guild_id,channel_id,status")
      .eq("guild_id", guildId)
      .eq("channel_id", channelId)
      .limit(1),
    parseManagedChannel,
  );
}

export async function listManagedChannels(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("managed_channels")
      .select("guild_id,channel_id,status")
      .eq("guild_id", guildId)
      .order("channel_id")
      .limit(MAX_CHANNELS + 1),
    parseManagedChannel,
    MAX_CHANNELS,
  );
}

/** Every active channel of every guild, for the health check. */
export async function listActiveManagedChannels(
  db: DbClient,
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return cappedList(
    await rest(db)
      .from("managed_channels")
      .select("guild_id,channel_id,status")
      .eq("status", "active")
      .order("guild_id")
      .order("channel_id")
      .limit(MAX_CHANNELS + 1),
    parseManagedChannel,
    MAX_CHANNELS,
  );
}

/** The given channels that this guild has a row for, whatever their status. */
export async function listManagedChannelsByIds(
  db: DbClient,
  { guildId, channelIds }: { guildId: string; channelIds: readonly string[] },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  if (!isSnowflake(guildId) || !isSnowflakeList(channelIds)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("managed_channels")
      .select("guild_id,channel_id,status")
      .eq("guild_id", guildId)
      .in("channel_id", snowflakeList(channelIds))
      .order("channel_id")
      .limit(MAX_CHANNELS + 1),
    parseManagedChannel,
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
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("events")
      .select(
        "id,guild_id,channel_id,name,event_date,thread_id,overview_message_id,status,thread_status,created_by,deleted_at,created_at",
      )
      .eq("guild_id", guildId)
      .eq("channel_id", channelId)
      .eq("thread_status", "active")
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .order("id")
      .limit(limit + 1),
    parseEvent,
    limit,
  );
}

/** For the health check. False if the channel was not active, which is not a failure. */
export async function markChannelUnavailable(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<boolean>> {
  if (!isSnowflake(guildId) || !isSnowflake(channelId)) {
    return refused();
  }
  return booleanValue(
    await rest(db).rpc("mark_channel_unavailable", {
      p_guild_id: guildId,
      p_channel_id: channelId,
    }),
  );
}
