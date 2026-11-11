import { isUsableTimeZone } from "../lib/dates.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
import {
  cappedList,
  integerValue,
  oneOrNone,
  type CappedList,
} from "./result.ts";
import {
  parseConfigChange,
  parseGuildConfig,
  type ConfigChange,
  type GuildConfig,
} from "./types.ts";
import {
  MAX_TIMEZONE_LENGTH,
  isSnowflakeList,
  isStoredText,
  isVersion,
} from "./validate.ts";

/** The most a Discord select menu can submit, and the most the function accepts. */
const MAX_CHANNELS_PER_CHANGE = 25;
const RECENT_CHANGES = 5;

export async function getGuildConfig(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<GuildConfig | null>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("guild_config")
      .select(
        "guild_id,officer_role_id,admin_role_id,timezone,reminders_enabled,version",
      )
      .eq("guild_id", guildId)
      .limit(1),
    parseGuildConfig,
  );
}

export interface RoleBindings {
  guildId: string;
  actorId: string;
  expectedVersion: number;
  officerRoleId: string;
  adminRoleId: string;
}

/** Returns the new config version. A stale version fails as `stale_version`. */
export async function applyRoleBindings(
  db: DbClient,
  {
    guildId,
    actorId,
    expectedVersion,
    officerRoleId,
    adminRoleId,
  }: RoleBindings,
): Promise<DbResult<number>> {
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    !isSnowflake(officerRoleId) ||
    !isSnowflake(adminRoleId) ||
    !isVersion(expectedVersion) ||
    // The guild's ID is also the ID of its @everyone role.
    officerRoleId === guildId ||
    adminRoleId === guildId
  ) {
    return refused();
  }
  return integerValue(
    await rest(db).rpc("apply_role_bindings", {
      p_guild_id: guildId,
      p_expected_version: expectedVersion,
      p_actor_id: actorId,
      p_officer_role_id: officerRoleId,
      p_admin_role_id: adminRoleId,
    }),
  );
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
  if (
    !isSnowflake(guildId) ||
    !isSnowflake(actorId) ||
    !isVersion(expectedVersion) ||
    !isSnowflakeList(addChannelIds, MAX_CHANNELS_PER_CHANGE) ||
    !isSnowflakeList(removeChannelIds, MAX_CHANNELS_PER_CHANGE) ||
    !(
      timezone === null ||
      (isStoredText(timezone, MAX_TIMEZONE_LENGTH) &&
        isUsableTimeZone(timezone))
    )
  ) {
    return refused();
  }
  return integerValue(
    await rest(db).rpc("apply_config_change", {
      p_guild_id: guildId,
      p_expected_version: expectedVersion,
      p_actor_id: actorId,
      p_reminders_enabled: remindersEnabled,
      p_add_channel_ids: [...addChannelIds],
      p_remove_channel_ids: [...removeChannelIds],
      p_timezone: timezone,
    }),
  );
}

/** The latest changes for the config panel, newest first. */
export async function listRecentConfigChanges(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ConfigChange>>> {
  if (!isSnowflake(guildId)) {
    return refused();
  }
  return cappedList(
    await rest(db)
      .from("config_audit")
      .select(
        "id,actor_id,action,old_values,new_values,version_after,created_at",
      )
      .eq("guild_id", guildId)
      .order("id", { ascending: false })
      .limit(RECENT_CHANGES + 1),
    parseConfigChange,
    RECENT_CHANGES,
  );
}
