import { hash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { isUsableTimeZone } from "../lib/dates.ts";
import type { DbClient } from "./client.ts";
import { updateRecorded } from "./history.ts";
import { capped, firstRow, raise, read, transact } from "./internal.ts";
import { failure, refused, type DbResult } from "./errors.ts";
import {
  configAudit,
  guildConfig,
  managedChannels,
  setupDrafts,
} from "./schema.ts";
import type {
  CappedList,
  ConfigChange,
  GuildConfig,
  SetupDraft,
} from "./types.ts";
import { MAX_TIMEZONE_LENGTH, isStoredText } from "./validate.ts";

const RECENT_CHANGES = 5;

export async function getGuildConfig(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<GuildConfig | null>> {
  return firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select({
            guild_id: guildConfig.guildId,
            officer_role_id: guildConfig.officerRoleId,
            admin_role_id: guildConfig.adminRoleId,
            eboard_role_id: guildConfig.eboardRoleId,
            events_committee_role_id: guildConfig.eventsCommitteeRoleId,
            treasury_role_id: guildConfig.treasuryRoleId,
            marketing_role_id: guildConfig.marketingRoleId,
            timezone: guildConfig.timezone,
            reminders_enabled: guildConfig.remindersEnabled,
            version: guildConfig.version,
          })
          .from(guildConfig)
          .where(eq(guildConfig.guildId, guildId))
          .limit(1) as unknown as Promise<GuildConfig[]>,
    ),
  );
}

/** The six roles /setup chooses. `officerRoleId` is the role shown as Events Directors. */
export interface SetupRoles {
  officerRoleId: string;
  adminRoleId: string;
  eboardRoleId: string;
  eventsCommitteeRoleId: string;
  treasuryRoleId: string;
  marketingRoleId: string;
}

export interface RoleBindings {
  guildId: string;
  actorId: string;
  expectedVersion: number;
  /** Shown as Events Directors. */
  officerRoleId: string;
  adminRoleId: string;
  /** Null leaves the role unbound. */
  eboardRoleId: string | null;
  eventsCommitteeRoleId: string | null;
  treasuryRoleId: string | null;
  marketingRoleId: string | null;
}

/**
 * Returns the new config version. A stale version fails as `stale_version`. Every role is
 * written: a null one is stored as unbound, not left as it was.
 */
export async function applyRoleBindings(
  db: DbClient,
  {
    guildId,
    actorId,
    expectedVersion,
    officerRoleId,
    adminRoleId,
    eboardRoleId,
    eventsCommitteeRoleId,
    treasuryRoleId,
    marketingRoleId,
  }: RoleBindings,
): Promise<DbResult<number>> {
  const roles = {
    officer_role_id: officerRoleId,
    admin_role_id: adminRoleId,
    eboard_role_id: eboardRoleId,
    events_committee_role_id: eventsCommitteeRoleId,
    treasury_role_id: treasuryRoleId,
    marketing_role_id: marketingRoleId,
  };
  return transact(db, async (tx) => {
    const [current] = await tx
      .select()
      .from(guildConfig)
      .where(eq(guildConfig.guildId, guildId))
      .for("update");

    let written: { version: number } | undefined;
    let oldValues: Record<string, string | null> | null = null;
    if (current !== undefined) {
      if (current.version !== expectedVersion) {
        raise("CF409", "config version is stale");
      }
      oldValues = {
        officer_role_id: current.officerRoleId,
        admin_role_id: current.adminRoleId,
        eboard_role_id: current.eboardRoleId,
        events_committee_role_id: current.eventsCommitteeRoleId,
        treasury_role_id: current.treasuryRoleId,
        marketing_role_id: current.marketingRoleId,
      };
      [written] = (await updateRecorded(
        tx,
        guildConfig,
        {
          officerRoleId,
          adminRoleId,
          eboardRoleId,
          eventsCommitteeRoleId,
          treasuryRoleId,
          marketingRoleId,
          version: sql`${guildConfig.version} + 1`,
        },
        eq(guildConfig.guildId, guildId),
        { version: guildConfig.version },
      )) as { version: number }[];
    } else {
      if (expectedVersion !== 0) {
        raise("CF409", "config version is stale");
      }
      // A concurrent first setup can pass the check above. The conflict returns no row,
      // which is reported as a stale version.
      [written] = await tx
        .insert(guildConfig)
        .values({
          guildId,
          officerRoleId,
          adminRoleId,
          eboardRoleId,
          eventsCommitteeRoleId,
          treasuryRoleId,
          marketingRoleId,
        })
        .onConflictDoNothing({ target: guildConfig.guildId })
        .returning({ version: guildConfig.version });
    }
    if (written === undefined) {
      raise("CF409", "config version is stale");
    }

    await tx.insert(configAudit).values({
      guildId,
      actorId,
      action: "role_bindings",
      oldValues,
      newValues: roles,
      versionAfter: written.version,
    });
    return written.version;
  });
}

/** How long a /setup draft stays usable. Older ones read as absent. */
const SETUP_DRAFT_TTL_MS = 3_600_000;

/**
 * A short, fixed-length digest of the six roles in a fixed order, for a Confirm
 * custom_id to carry. A click whose fingerprint differs from the stored draft's was
 * shown other roles than the draft now holds.
 */
export function setupDraftFingerprint(roles: SetupRoles): string {
  const ids = [
    roles.officerRoleId,
    roles.adminRoleId,
    roles.eboardRoleId,
    roles.eventsCommitteeRoleId,
    roles.treasuryRoleId,
    roles.marketingRoleId,
  ];
  // Hex, so it fits the router's fingerprint field.
  return hash("sha256", ids.join(":"), "hex").slice(0, 16);
}

/**
 * Stores what /setup showed, replacing the guild's earlier draft. The fingerprint is
 * worked out here from the roles, so a draft and its fingerprint always agree.
 * Returns the fingerprint for the Confirm button.
 */
export async function saveSetupDraft(
  db: DbClient,
  {
    guildId,
    actorId,
    roles,
  }: { guildId: string; actorId: string; roles: SetupRoles },
): Promise<DbResult<string>> {
  const fingerprint = setupDraftFingerprint(roles);
  // Everything but the guild, which is the draft's key and is not granted for update.
  const draft = {
    actorId,
    officerRoleId: roles.officerRoleId,
    adminRoleId: roles.adminRoleId,
    eboardRoleId: roles.eboardRoleId,
    eventsCommitteeRoleId: roles.eventsCommitteeRoleId,
    treasuryRoleId: roles.treasuryRoleId,
    marketingRoleId: roles.marketingRoleId,
    fingerprint,
  };
  const saved = await transact(db, async (tx) => {
    // A draft already there is changed with its history; two first drafts at once leave
    // one row, and the second changes it.
    const made = await tx
      .insert(setupDrafts)
      .values({ guildId, ...draft })
      .onConflictDoNothing({ target: setupDrafts.guildId })
      .returning({ guildId: setupDrafts.guildId });
    if (made.length === 0) {
      await updateRecorded(
        tx,
        setupDrafts,
        { ...draft, createdAt: sql`now()` },
        eq(setupDrafts.guildId, guildId),
        { guildId: setupDrafts.guildId },
      );
    }
  });
  return saved.ok ? { ok: true, value: fingerprint } : saved;
}

/**
 * The guild's draft from the last hour, or null. Pass the fingerprint the click carried:
 * a draft with another fingerprint, or one saved by another member, also reads as null,
 * so a stale button can never apply roles it did not show.
 */
export async function getSetupDraft(
  db: DbClient,
  {
    guildId,
    actorId,
    fingerprint,
    now,
  }: { guildId: string; actorId: string; fingerprint: string; now: Date },
): Promise<DbResult<SetupDraft | null>> {
  const draft = firstRow(
    await read(
      db,
      (orm) =>
        orm
          .select({
            guild_id: setupDrafts.guildId,
            actor_id: setupDrafts.actorId,
            officer_role_id: setupDrafts.officerRoleId,
            admin_role_id: setupDrafts.adminRoleId,
            eboard_role_id: setupDrafts.eboardRoleId,
            events_committee_role_id: setupDrafts.eventsCommitteeRoleId,
            treasury_role_id: setupDrafts.treasuryRoleId,
            marketing_role_id: setupDrafts.marketingRoleId,
            fingerprint: setupDrafts.fingerprint,
            created_at: setupDrafts.createdAt,
          })
          .from(setupDrafts)
          .where(
            and(
              eq(setupDrafts.guildId, guildId),
              eq(setupDrafts.actorId, actorId),
              eq(setupDrafts.fingerprint, fingerprint),
              gt(
                setupDrafts.createdAt,
                new Date(now.getTime() - SETUP_DRAFT_TTL_MS).toISOString(),
              ),
            ),
          )
          .limit(1) as unknown as Promise<SetupDraft[]>,
    ),
  );
  if (!draft.ok || draft.value === null) {
    return draft;
  }
  // The fingerprint is stored as given, so check it still matches the roles beside it.
  return setupDraftFingerprint(draftRoles(draft.value)) ===
    draft.value.fingerprint
    ? draft
    : { ok: true, value: null };
}

/** The roles of a draft, in the shape `applyRoleBindings` takes. */
export function draftRoles(draft: SetupDraft): SetupRoles {
  return {
    officerRoleId: draft.officer_role_id,
    adminRoleId: draft.admin_role_id,
    eboardRoleId: draft.eboard_role_id,
    eventsCommitteeRoleId: draft.events_committee_role_id,
    treasuryRoleId: draft.treasury_role_id,
    marketingRoleId: draft.marketing_role_id,
  };
}

export interface ConfigChangeInput {
  guildId: string;
  actorId: string;
  expectedVersion: number;
  /** Null leaves the setting alone. */
  remindersEnabled: boolean | null;
  addChannelIds: readonly string[];
  removeChannelIds: readonly string[];
  /** Null leaves the setting alone. The database checks that the zone exists. */
  timezone: string | null;
}

/** Returns the new config version. A stale version fails as `stale_version`. */
export async function applyConfigChange(
  db: DbClient,
  {
    guildId,
    actorId,
    expectedVersion,
    remindersEnabled,
    addChannelIds,
    removeChannelIds,
    timezone,
  }: ConfigChangeInput,
): Promise<DbResult<number>> {
  if (!(
    timezone === null ||
    (isStoredText(timezone, MAX_TIMEZONE_LENGTH) && isUsableTimeZone(timezone))
  )) {
    return refused();
  }
  const added = [...new Set(addChannelIds)];
  const removed = [...new Set(removeChannelIds)];
  // 25 is the most a Discord select menu can submit at once.
  if (
    (remindersEnabled === null &&
      timezone === null &&
      addChannelIds.length === 0 &&
      removeChannelIds.length === 0) ||
    addChannelIds.length > 25 ||
    removeChannelIds.length > 25 ||
    [...added, ...removed].some(
      (channelId) => (channelId as string | null) === null,
    ) ||
    added.some((channelId) => removed.includes(channelId))
  ) {
    return failure("constraint", "22023");
  }

  return transact(db, async (tx) => {
    const [current] = await tx
      .select()
      .from(guildConfig)
      .where(eq(guildConfig.guildId, guildId))
      .for("update");
    if (current?.version !== expectedVersion) {
      raise("CF409", "config version is stale");
    }

    const activeChannels = async (): Promise<string[]> =>
      (
        await tx
          .select({ channelId: managedChannels.channelId })
          .from(managedChannels)
          .where(
            and(
              eq(managedChannels.guildId, guildId),
              eq(managedChannels.status, "active"),
            ),
          )
          .orderBy(asc(managedChannels.channelId))
      ).map((row) => row.channelId);

    const oldChannels = await activeChannels();
    const addedIds = added
      .filter((channelId) => !oldChannels.includes(channelId))
      .sort();

    if (added.length > 0) {
      // New channels are inserted; one already there is made active again, with history.
      await tx
        .insert(managedChannels)
        .values(added.map((channelId) => ({ guildId, channelId })))
        .onConflictDoNothing();
      await updateRecorded(
        tx,
        managedChannels,
        { status: "active" },
        and(
          eq(managedChannels.guildId, guildId),
          inArray(managedChannels.channelId, added),
          ne(managedChannels.status, "active"),
        ),
        { channelId: managedChannels.channelId },
      );
    }

    if (removed.length > 0) {
      const changed = await updateRecorded(
        tx,
        managedChannels,
        { status: "removed" },
        and(
          eq(managedChannels.guildId, guildId),
          inArray(managedChannels.channelId, removed),
          ne(managedChannels.status, "removed"),
        ),
        { channelId: managedChannels.channelId },
      );
      if (changed.length !== removed.length) {
        raise("22023", "channel to remove is not managed");
      }
    }

    const newChannels = await activeChannels();

    const [updated] = (await updateRecorded(
      tx,
      guildConfig,
      {
        ...(remindersEnabled === null ? {} : { remindersEnabled }),
        ...(timezone === null ? {} : { timezone }),
        version: sql`${guildConfig.version} + 1`,
      },
      eq(guildConfig.guildId, guildId),
      {
        version: guildConfig.version,
        remindersEnabled: guildConfig.remindersEnabled,
        timezone: guildConfig.timezone,
      },
    )) as { version: number; remindersEnabled: boolean; timezone: string }[];
    if (updated === undefined) {
      raise("CF409", "config version is stale");
    }

    await tx.insert(configAudit).values({
      guildId,
      actorId,
      action: "settings",
      oldValues: {
        reminders_enabled: current.remindersEnabled,
        timezone: current.timezone,
        active_channel_ids: oldChannels,
      },
      newValues: {
        reminders_enabled: updated.remindersEnabled,
        timezone: updated.timezone,
        active_channel_ids: newChannels,
        added_channel_ids: addedIds,
        removed_channel_ids: [...removed].sort(),
      },
      versionAfter: updated.version,
    });
    return updated.version;
  });
}

/** The latest changes for the config panel, newest first. */
export async function listRecentConfigChanges(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ConfigChange>>> {
  return capped(
    await read(
      db,
      (orm) =>
        orm
          .select({
            id: configAudit.id,
            actor_id: configAudit.actorId,
            action: configAudit.action,
            old_values: configAudit.oldValues,
            new_values: configAudit.newValues,
            version_after: configAudit.versionAfter,
            created_at: configAudit.createdAt,
          })
          .from(configAudit)
          .where(eq(configAudit.guildId, guildId))
          .orderBy(desc(configAudit.id))
          .limit(RECENT_CHANGES + 1) as unknown as Promise<ConfigChange[]>,
    ),
    RECENT_CHANGES,
  );
}
