/** The real database and Discord client, built from the environment on first use. */

import { createDiscordClient } from "../discord/client.ts";
import type { ManagedChannelCheck } from "../discord/client.ts";
import { getDb, getInteractionDb } from "../db/client.ts";
import type { DbClient } from "../db/client.ts";
import { getManagedChannel } from "../db/managed-channels.ts";
import type { RouterDependencies } from "./router.ts";

/**
 * Only an active row counts, so a removed forum stops getting posts at once. A failed
 * read says nothing about the forum, so it throws: the client still refuses the send,
 * and reports a failed check and not an unmanaged forum.
 */
export function managedChannelCheck(db: DbClient): ManagedChannelCheck {
  return {
    async isManaged(guildId, channelId) {
      const row = await getManagedChannel(db, { guildId, channelId });
      if (!row.ok) {
        // The error itself is not looked at, and is not passed on.
        throw new Error("managed channel check failed");
      }
      return row.value?.status === "active";
    },
  };
}

export function liveDependencies(): RouterDependencies {
  return {
    db: getInteractionDb,
    finishDb: getDb,
    discord: () => createDiscordClient({ check: managedChannelCheck(getDb()) }),
  };
}
