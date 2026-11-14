import { PermissionFlagsBits } from "discord-api-types/v10";
import { describe, expect, it } from "bun:test";
import {
  channelPermissions,
  everyoneCanView,
  hasPermission,
} from "./channel-permissions.ts";
import type { GuildChannel, GuildRole, PermissionOverwrite } from "./client.ts";
import { fakeId } from "../../test/support/ids.ts";

const GUILD = fakeId(1);
const ROLE = fakeId(2);
const OTHER_ROLE = fakeId(3);
const MEMBER = fakeId(4);
const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;

function role(id: string, permissions: bigint): GuildRole {
  return { id, name: "r", permissions, position: 1, managed: false };
}

function channel(...overwrites: PermissionOverwrite[]): GuildChannel {
  return { id: fakeId(5), name: "c", type: 15, overwrites };
}

function overwrite(
  id: string,
  type: number,
  allow: bigint,
  deny: bigint,
): PermissionOverwrite {
  return { id, type, allow, deny };
}

describe("channelPermissions", () => {
  const permissionsWith = (
    roles: GuildRole[],
    forum: GuildChannel,
    memberRoleIds: string[] = [],
  ) =>
    channelPermissions({
      guildId: GUILD,
      roles,
      channel: forum,
      memberRoleIds,
      memberId: MEMBER,
    });

  it("is undefined without the @everyone role", () => {
    expect(permissionsWith([role(ROLE, VIEW)], channel())).toBeUndefined();
  });

  it("adds the member's roles to @everyone and ignores other roles", () => {
    const permissions = permissionsWith(
      [role(GUILD, 0n), role(ROLE, VIEW), role(OTHER_ROLE, SEND)],
      channel(),
      [ROLE],
    );

    expect(permissions).toBe(VIEW);
  });

  it("lets a role overwrite beat the @everyone overwrite, and a member one both", () => {
    const forum = channel(
      overwrite(GUILD, 0, 0n, VIEW),
      overwrite(ROLE, 0, VIEW | SEND, 0n),
      overwrite(MEMBER, 1, 0n, SEND),
    );

    expect(permissionsWith([role(GUILD, VIEW)], forum, [ROLE])).toBe(VIEW);
  });

  it("applies a deny on a held role, unless a member overwrite allows it", () => {
    const allowedThenDenied = [
      overwrite(GUILD, 0, SEND, 0n),
      overwrite(ROLE, 0, 0n, SEND),
    ];
    const everyone = [role(GUILD, VIEW)];

    expect(
      permissionsWith(everyone, channel(...allowedThenDenied), [ROLE]),
    ).toBe(VIEW);
    expect(permissionsWith(everyone, channel(...allowedThenDenied))).toBe(
      VIEW | SEND,
    );
    expect(
      permissionsWith(
        everyone,
        channel(...allowedThenDenied, overwrite(MEMBER, 1, SEND, 0n)),
        [ROLE],
      ),
    ).toBe(VIEW | SEND);
  });

  it("does not apply a member overwrite to someone else or a role overwrite to a non-holder", () => {
    const forum = channel(
      overwrite(fakeId(9), 1, VIEW, 0n),
      overwrite(ROLE, 0, SEND, 0n),
    );

    expect(permissionsWith([role(GUILD, 0n)], forum)).toBe(0n);
  });

  it("gives an administrator everything, whatever the overwrites", () => {
    const forum = channel(overwrite(GUILD, 0, 0n, VIEW | SEND));
    const permissions = permissionsWith(
      [role(GUILD, 0n), role(ROLE, PermissionFlagsBits.Administrator)],
      forum,
      [ROLE],
    );

    expect(hasPermission(permissions ?? 0n, VIEW | SEND)).toBe(true);
  });

  it("does not round high bits into the Administrator bit", () => {
    const high = (1n << 54n) | 7n;

    expect(permissionsWith([role(GUILD, high)], channel())).toBe(high);
  });
});

describe("everyoneCanView", () => {
  it.each([
    ["the role grants it", VIEW, [], true],
    ["an overwrite denies it", VIEW, [overwrite(GUILD, 0, 0n, VIEW)], false],
    ["an overwrite allows it", 0n, [overwrite(GUILD, 0, VIEW, 0n)], true],
  ] as const)("when %s", (_label, permissions, overwrites, expected) => {
    expect(
      everyoneCanView(
        GUILD,
        [role(GUILD, permissions)],
        channel(...overwrites),
      ),
    ).toBe(expected);
  });

  it("does not guess without the @everyone role", () => {
    expect(everyoneCanView(GUILD, [], channel())).toBeUndefined();
  });
});
