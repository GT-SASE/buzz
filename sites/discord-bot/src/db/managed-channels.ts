import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "./client.ts";
import { EVENT_ROW } from "./events.ts";
import { updateRecorded } from "./history.ts";
import { capped, firstRow, read, transact } from "./internal.ts";
import type { DbResult } from "./errors.ts";
import { events, jobRuns, managedChannels } from "./schema.ts";
import type { CappedList, EventRow, ManagedChannel } from "./types.ts";

const MAX_CHANNELS = 500;

const CHANNEL_ROW = {
  guild_id: managedChannels.guildId,
  channel_id: managedChannels.channelId,
  status: managedChannels.status,
};

export async function getManagedChannel(
  db: DbClient,
  { guildId, channelId }: { guildId: string; channelId: string },
): Promise<DbResult<ManagedChannel | null>> {
  return firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select(CHANNEL_ROW)
          .from(managedChannels)
          .where(
            and(
              eq(managedChannels.guildId, guildId),
              eq(managedChannels.channelId, channelId),
            ),
          )
          .limit(1) as unknown as Promise<ManagedChannel[]>,
    ),
  );
}

export async function listManagedChannels(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select(CHANNEL_ROW)
          .from(managedChannels)
          .where(eq(managedChannels.guildId, guildId))
          .orderBy(asc(managedChannels.channelId))
          .limit(MAX_CHANNELS + 1) as unknown as Promise<ManagedChannel[]>,
    ),
    MAX_CHANNELS,
  );
}

/** Every active channel of every guild, for the health check. */
export async function listActiveManagedChannels(
  db: DbClient,
): Promise<DbResult<CappedList<ManagedChannel>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select(CHANNEL_ROW)
          .from(managedChannels)
          .where(eq(managedChannels.status, "active"))
          .orderBy(asc(managedChannels.guildId), asc(managedChannels.channelId))
          .limit(MAX_CHANNELS + 1) as unknown as Promise<ManagedChannel[]>,
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
    await read(
      db,
      (orm) =>
        orm
          .select(EVENT_ROW)
          .from(events)
          .where(
            and(
              eq(events.guildId, guildId),
              eq(events.channelId, channelId),
              eq(events.threadStatus, "active"),
              isNull(events.deletedAt),
            ),
          )
          .orderBy(desc(events.updatedAt), asc(events.id))
          .limit(limit + 1) as unknown as Promise<EventRow[]>,
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
    const changedRows = await updateRecorded(
      tx,
      managedChannels,
      { status: "unavailable" },
      and(
        eq(managedChannels.guildId, guildId),
        eq(managedChannels.channelId, channelId),
        eq(managedChannels.status, "active"),
      ),
      { channelId: managedChannels.channelId },
    );
    const changed = changedRows.length > 0;

    // The health check reads the latest of these, so the finding is kept either way.
    await tx.insert(jobRuns).values({
      jobName: "mark_channel_unavailable",
      status: "succeeded",
      finishedAt: sql`now()`,
      results: { guild_id: guildId, channel_id: channelId, changed },
    });
    return changed;
  });
}
