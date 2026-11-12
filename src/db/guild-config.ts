import { hash } from "node:crypto";
import { isUsableTimeZone } from "../lib/dates.ts";
import type { DbClient } from "./client.ts";
import { callFunction, capped, firstRow, query, sql } from "./internal.ts";
import { refused, type DbResult } from "./errors.ts";
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
    await query<GuildConfig>(
      db,
      sql`select guild_id, officer_role_id, admin_role_id, eboard_role_id,
        events_committee_role_id, treasury_role_id, marketing_role_id, timezone,
        reminders_enabled, version
      from guild_config where guild_id = ${guildId} limit 1`,
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
  return callFunction<number>(
    db,
    sql`select public.apply_role_bindings(p_guild_id => ${guildId},
      p_expected_version => ${expectedVersion}, p_actor_id => ${actorId},
      p_officer_role_id => ${officerRoleId}, p_admin_role_id => ${adminRoleId},
      p_eboard_role_id => ${eboardRoleId},
      p_events_committee_role_id => ${eventsCommitteeRoleId},
      p_treasury_role_id => ${treasuryRoleId},
      p_marketing_role_id => ${marketingRoleId}) as value`,
  );
}

/** How long a /setup draft stays usable. Older ones read as absent. */
export const SETUP_DRAFT_TTL_MS = 3_600_000;

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
  const saved = await callFunction<boolean>(
    db,
    sql`select public.save_setup_draft(p_guild_id => ${guildId},
      p_actor_id => ${actorId}, p_officer_role_id => ${roles.officerRoleId},
      p_admin_role_id => ${roles.adminRoleId},
      p_eboard_role_id => ${roles.eboardRoleId},
      p_events_committee_role_id => ${roles.eventsCommitteeRoleId},
      p_treasury_role_id => ${roles.treasuryRoleId},
      p_marketing_role_id => ${roles.marketingRoleId},
      p_fingerprint => ${fingerprint}) as value`,
  );
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
    await query<SetupDraft>(
      db,
      sql`select guild_id, actor_id, officer_role_id, admin_role_id, eboard_role_id,
        events_committee_role_id, treasury_role_id, marketing_role_id, fingerprint,
        created_at
      from setup_drafts
      where guild_id = ${guildId} and actor_id = ${actorId}
        and fingerprint = ${fingerprint}
        and created_at > ${new Date(now.getTime() - SETUP_DRAFT_TTL_MS).toISOString()}
      limit 1`,
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
  return callFunction<number>(
    db,
    sql`select public.apply_config_change(p_guild_id => ${guildId},
      p_expected_version => ${expectedVersion}, p_actor_id => ${actorId},
      p_reminders_enabled => ${remindersEnabled},
      p_add_channel_ids => ${[...addChannelIds]}::text[],
      p_remove_channel_ids => ${[...removeChannelIds]}::text[],
      p_timezone => ${timezone}) as value`,
  );
}

/** The latest changes for the config panel, newest first. */
export async function listRecentConfigChanges(
  db: DbClient,
  { guildId }: { guildId: string },
): Promise<DbResult<CappedList<ConfigChange>>> {
  return capped(
    await query<ConfigChange>(
      db,
      sql`select id, actor_id, action, old_values, new_values, version_after,
        created_at
      from config_audit where guild_id = ${guildId}
      order by id desc limit ${RECENT_CHANGES + 1}`,
    ),
    RECENT_CHANGES,
  );
}
