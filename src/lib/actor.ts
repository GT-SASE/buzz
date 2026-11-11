/**
 * Turns the member on a verified interaction into the Actor that authorization
 * works from. Build one for each interaction and do not keep it, so that a role
 * removed since a panel opened counts from the next click.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildInteraction } from "../discord/interactions.ts";
import { isSnowflake } from "./snowflake.ts";

export interface Actor {
  readonly userId: string;
  readonly guildId: string;
  readonly roleIds: ReadonlySet<string>;
  readonly isAdministrator: boolean;
}

// BigInt alone would accept "", " 8 " and "0x8". The length limit covers 128 bits
// and keeps the conversion cheap.
const PERMISSIONS = /^(?:0|[1-9]\d{0,38})$/;

/**
 * Permission bits go past 2^53, where a Number rounds and can make the
 * Administrator bit look set. Keep this value a BigInt from string to mask.
 */
export function parsePermissions(value: unknown): bigint | undefined {
  return typeof value === "string" && PERMISSIONS.test(value)
    ? BigInt(value)
    : undefined;
}

function parseRoleIds(value: unknown): ReadonlySet<string> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const roleIds: unknown[] = value;
  return roleIds.every(isSnowflake) ? new Set(roleIds) : undefined;
}

/**
 * Takes a GuildInteraction so that the caller must have run the allowed-server
 * guard first. Returns undefined if the roles or permissions are missing or
 * malformed, and the caller must then refuse. There is no partial Actor, because
 * guessing at either field would turn a surprise from Discord into access.
 */
export function parseActor(interaction: GuildInteraction): Actor | undefined {
  const member: Record<string, unknown> = interaction.member;
  const roleIds = parseRoleIds(member.roles);
  const permissions = parsePermissions(member.permissions);
  if (roleIds === undefined || permissions === undefined) {
    return undefined;
  }
  return {
    userId: interaction.member.user.id,
    guildId: interaction.guild_id,
    roleIds,
    isAdministrator:
      (permissions & PermissionFlagsBits.Administrator) ===
      PermissionFlagsBits.Administrator,
  };
}
