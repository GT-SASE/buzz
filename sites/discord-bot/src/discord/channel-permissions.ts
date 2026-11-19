/**
 * Works out what someone can do in a channel from the guild's roles and the
 * channel's overwrites, in the order Discord documents: the @everyone role and the
 * member's roles, then Administrator, then the @everyone overwrite, the role
 * overwrites and the member overwrite. Everything stays a BigInt, because permission
 * bits go past what a Number holds exactly.
 */

import { PermissionFlagsBits } from "discord-api-types/v10";
import type { GuildChannel, GuildRole } from "./client.ts";

const ALL_PERMISSIONS = (1n << 128n) - 1n;

const OVERWRITE_FOR_ROLE = 0;
const OVERWRITE_FOR_MEMBER = 1;

export interface ChannelAccessInput {
  readonly guildId: string;
  readonly roles: readonly GuildRole[];
  readonly channel: GuildChannel;
  readonly memberRoleIds: readonly string[];
  readonly memberId?: string;
}

export function hasPermission(permissions: bigint, bit: bigint): boolean {
  return (permissions & bit) === bit;
}

/** Undefined if the @everyone role is missing, which means the data is not usable. */
export function channelPermissions({
  guildId,
  roles,
  channel,
  memberRoleIds,
  memberId,
}: ChannelAccessInput): bigint | undefined {
  const everyone = roles.find((role) => role.id === guildId);
  if (everyone === undefined) {
    return undefined;
  }
  const held = new Set(memberRoleIds);
  let permissions = everyone.permissions;
  for (const role of roles) {
    if (held.has(role.id)) {
      permissions |= role.permissions;
    }
  }
  if (hasPermission(permissions, PermissionFlagsBits.Administrator)) {
    return ALL_PERMISSIONS;
  }

  const apply = (allow: bigint, deny: bigint) => {
    permissions = (permissions & ~deny) | allow;
  };
  for (const overwrite of channel.overwrites) {
    if (overwrite.id === guildId) {
      apply(overwrite.allow, overwrite.deny);
    }
  }
  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of channel.overwrites) {
    if (overwrite.type === OVERWRITE_FOR_ROLE && held.has(overwrite.id)) {
      roleAllow |= overwrite.allow;
      roleDeny |= overwrite.deny;
    }
  }
  apply(roleAllow, roleDeny);
  for (const overwrite of channel.overwrites) {
    if (overwrite.type === OVERWRITE_FOR_MEMBER && overwrite.id === memberId) {
      apply(overwrite.allow, overwrite.deny);
    }
  }
  return permissions;
}

/** True or false when the data allows an answer, undefined when it does not. */
export function everyoneCanView(
  guildId: string,
  roles: readonly GuildRole[],
  channel: GuildChannel,
): boolean | undefined {
  const permissions = channelPermissions({
    guildId,
    roles,
    channel,
    memberRoleIds: [],
  });
  return permissions === undefined
    ? undefined
    : hasPermission(permissions, PermissionFlagsBits.ViewChannel);
}
