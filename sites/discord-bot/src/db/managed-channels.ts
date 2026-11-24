import { and, eq, sql as dsql } from "drizzle-orm";
import type { DbClient } from "./client.ts";
import { EVENT_COLUMNS } from "./events.ts";
import { capped, firstRow, query, sql, transact } from "./internal.ts";
import type { DbResult } from "./errors.ts";
import { jobRuns, managedChannels } from "./schema.ts";
import type { CappedList, EventRow, ManagedChannel } from "./types.ts";

const MAX_CHANNELS = 500;

export async function getManagedChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<ManagedChannel | null>> {
  return firstRow(
    await query<ManagedChannel>(
      db,
      sql`select guild_id, channel_id, status from discord_bot.managed_channels
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
      sql`select guild_id, channel_id, status from discord_bot.managed_channels
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
      sql`select guild_id, channel_id, status from discord_bot.managed_channels
      where status = 'active'
      order by guild_id, channel_id limit ${MAX_CHANNELS + 1}`,
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
      sql`select ${EVENT_COLUMNS} from discord_bot.events
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
  return transact(db, async (tx) => {
    const changedRows = await tx
      .update(managedChannels)
      .set({ status: "unavailable" })
      .where(
        and(
          eq(managedChannels.guildId, guildId),
          eq(managedChannels.channelId, channelId),
          eq(managedChannels.status, "active"),
        ),
      )
      .returning({ channelId: managedChannels.channelId });
    const changed = changedRows.length > 0;

    // The health check reads the latest of these, so the finding is kept either way.
    await tx.insert(jobRuns).values({
      jobName: "mark_channel_unavailable",
      status: "succeeded",
      finishedAt: dsql`now()`,
      results: { guild_id: guildId, channel_id: channelId, changed },
    });
    return changed;
  });
}
