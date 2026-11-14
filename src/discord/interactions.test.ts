import {
  ApplicationCommandOptionType as Option,
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import { describe, expect, it } from "bun:test";
import { parseActor } from "../lib/actor.ts";
import { isSnowflake } from "../lib/snowflake.ts";
import {
  channelPermissions,
  everyoneCanView,
  hasPermission,
} from "./channel-permissions.ts";
import type { GuildChannel, GuildRole, PermissionOverwrite } from "./client.ts";
import {
  commandOptionValue,
  parseAllowedGuildInteraction,
  resolvedChannel,
  resolvedPerson,
  resolvedRole,
  type GuildInteraction,
} from "./interactions.ts";
import { fakeId } from "../../test/support/ids.ts";

const ROLE = fakeId(1);
const CHANNEL = fakeId(2);
const GUILD = fakeId(3);

const roleEntry = {
  id: ROLE,
  name: "Officers",
  managed: false,
  position: 2,
  permissions: "8",
};

function withResolved(kind: "roles" | "channels", entries: unknown) {
  return { data: { resolved: { [kind]: entries } } };
}

describe("resolvedRole", () => {
  it("reads a role, keeping permissions a BigInt", () => {
    expect(
      resolvedRole(withResolved("roles", { [ROLE]: roleEntry }), ROLE),
    ).toEqual({ ...roleEntry, permissions: 8n });
  });

  it("finds nothing under __proto__ or through the prototype", () => {
    const own = JSON.parse(
      `{"__proto__": ${JSON.stringify({ ...roleEntry, id: "__proto__" })}}`,
    ) as unknown;
    const inherited = Object.create({ [ROLE]: roleEntry }) as unknown;

    expect(
      resolvedRole(withResolved("roles", own), "__proto__"),
    ).toBeUndefined();
    expect(
      resolvedRole(withResolved("roles", inherited), ROLE),
    ).toBeUndefined();
  });

  it.each([
    ["an entry filed under another role's ID", { id: fakeId(9) }],
    ["no name", { name: undefined }],
    ["hex permissions", { permissions: "0x8" }],
  ])("refuses %s", (_label, change) => {
    const entries = { [ROLE]: { ...roleEntry, ...change } };

    expect(resolvedRole(withResolved("roles", entries), ROLE)).toBeUndefined();
  });
});

describe("resolvedChannel", () => {
  const entry = { id: CHANNEL, type: 15, guild_id: GUILD };

  it("reads a channel and its guild, keeping app_permissions a BigInt", () => {
    const high = 1n << 54n;

    expect(
      resolvedChannel(
        withResolved("channels", {
          [CHANNEL]: { ...entry, app_permissions: String(high) },
        }),
        CHANNEL,
      ),
    ).toEqual({ id: CHANNEL, type: 15, guildId: GUILD, appPermissions: high });
  });

  it.each([
    ["a type that is not a number", { type: "15" }],
    ["a malformed guild", { guild_id: "x" }],
    ["hex app_permissions", { app_permissions: "0x8" }],
  ])("refuses %s", (_label, change) => {
    expect(
      resolvedChannel(
        withResolved("channels", { [CHANNEL]: { ...entry, ...change } }),
        CHANNEL,
      ),
    ).toBeUndefined();
  });
});

describe("resolvedPerson", () => {
  const PERSON = fakeId(4);
  const user = { id: PERSON, username: "someone" };
  const payload = (resolved: unknown) => ({ data: { resolved } });
  const members = { [PERSON]: { roles: [] } };

  it("reads a member of the guild, and tells a non-member apart", () => {
    expect(
      resolvedPerson(payload({ users: { [PERSON]: user }, members }), PERSON),
    ).toEqual({ id: PERSON, isMember: true, isBot: false });
    expect(
      resolvedPerson(payload({ users: { [PERSON]: user } }), PERSON)?.isMember,
    ).toBe(false);
  });

  it.each([
    ["bot true", { bot: true }, true],
    ["an odd system value", { system: 0 }, true],
  ])("reads %s as a bot", (_label, change, isBot) => {
    expect(
      resolvedPerson(
        payload({ users: { [PERSON]: { ...user, ...change } }, members }),
        PERSON,
      )?.isBot,
    ).toBe(isBot);
  });

  it.each([
    ["no payload", undefined, PERSON],
    [
      "a mismatched entry",
      payload({ users: { [PERSON]: { id: GUILD } } }),
      PERSON,
    ],
    ["a key on the prototype", payload({ users: {} }), "__proto__"],
  ])("finds nothing for %s", (_label, value, id) => {
    expect(resolvedPerson(value, id)).toBeUndefined();
  });
});

describe("commandOptionValue", () => {
  const withOptions = (options: unknown) => ({ data: { options } });

  it("reads one option of the right name and type, also inside a subcommand", () => {
    const option = { name: "role", type: Option.Role, value: ROLE };

    expect(commandOptionValue(withOptions([option]), "role", Option.Role)).toBe(
      ROLE,
    );
    expect(
      commandOptionValue(
        withOptions([
          { name: "sub", type: Option.Subcommand, options: [option] },
        ]),
        "role",
        Option.Role,
      ),
    ).toBe(ROLE);
  });

  it.each([
    ["the wrong type", [{ name: "role", type: Option.String, value: ROLE }]],
    [
      "a duplicate",
      [
        { name: "role", type: Option.Role, value: ROLE },
        { name: "role", type: Option.Role, value: fakeId(8) },
      ],
    ],
  ])("finds nothing with %s", (_label, options) => {
    expect(
      commandOptionValue(withOptions(options), "role", Option.Role),
    ).toBeUndefined();
  });
});

describe("isSnowflake", () => {
  it.each([
    ["17 digits", "1".repeat(17), true],
    ["20 digits", "1".repeat(20), true],
    ["16 digits", "1".repeat(16), false],
    ["21 digits", "1".repeat(21), false],
    ["a leading zero", `0${"1".repeat(17)}`, false],
    ["a trailing newline", `${"1".repeat(18)}\n`, false],
    ["a number", 111_111, false],
  ])("reads %s as %p", (_label, value, expected) => {
    expect(isSnowflake(value)).toBe(expected);
  });
});

describe("parseActor", () => {
  const USER = fakeId(10);
  const APP = fakeId(11);
  const ADMINISTRATOR = 1n << 3n;

  /** The parser vouches for the user ID only, so the rest of the member is open. */
  function interactionWith(member: Record<string, unknown>): GuildInteraction {
    return {
      application_id: APP,
      guild_id: GUILD,
      context: InteractionContextType.Guild,
      authorizing_integration_owners: {
        [ApplicationIntegrationType.GuildInstall]: GUILD,
      },
      member: { user: { id: USER }, ...member },
    };
  }

  const withPermissions = (permissions: unknown) =>
    parseActor(interactionWith({ roles: [], permissions }));

  it("builds an Actor from the signed member", () => {
    expect(
      parseActor(interactionWith({ roles: [ROLE], permissions: "0" })),
    ).toEqual({
      userId: USER,
      guildId: GUILD,
      roleIds: new Set([ROLE]),
      isAdministrator: false,
    });
  });

  it.each([
    ["only Administrator", ADMINISTRATOR, true],
    ["Administrator with a bit above 2^53", (1n << 60n) | ADMINISTRATOR, true],
    // As a Number this rounds up to 2^54 + 8, which has the Administrator bit.
    ["2^54 + 7, which rounds onto the bit", (1n << 54n) | 7n, false],
  ])("reads the Administrator bit from %s", (_label, bits, expected) => {
    expect(withPermissions(bits.toString())?.isAdministrator).toBe(expected);
  });

  it.each([
    ["missing permissions", { permissions: undefined }],
    // BigInt("") is 0n and does not throw.
    ["empty permissions", { permissions: "" }],
    ["hex permissions, which BigInt accepts", { permissions: "0x8" }],
    ["negative permissions", { permissions: "-8" }],
    ["permissions as a JSON number", { permissions: 8 }],
    ["no roles", { roles: undefined }],
    ["roles as a string", { roles: ROLE }],
    ["one bad role ID", { roles: [ROLE, "not-an-id"] }],
  ])("refuses %s", (_label, change) => {
    expect(
      parseActor(interactionWith({ roles: [], permissions: "8", ...change })),
    ).toBeUndefined();
  });

  it("reads nothing from the prototype, and never sees a bad user ID", () => {
    const member = JSON.parse(
      `{"user":{"id":"${USER}"},"__proto__":{"roles":[],"permissions":"8"}}`,
    ) as Record<string, unknown>;
    const badUser = {
      ...interactionWith({ roles: [], permissions: "0" }),
      member: { user: { id: "not-an-id" }, roles: [], permissions: "0" },
    };

    expect(parseActor(interactionWith(member))).toBeUndefined();
    expect(
      parseAllowedGuildInteraction(badUser, {
        applicationId: APP,
        allowedGuildIds: new Set([GUILD]),
      }),
    ).toBeUndefined();
  });
});

describe("channel permissions", () => {
  const OTHER_ROLE = fakeId(12);
  const MEMBER = fakeId(13);
  const VIEW = PermissionFlagsBits.ViewChannel;
  const SEND = PermissionFlagsBits.SendMessages;

  const role = (id: string, permissions: bigint): GuildRole => ({
    id,
    name: "r",
    permissions,
    position: 1,
    managed: false,
  });
  const channel = (...overwrites: PermissionOverwrite[]): GuildChannel => ({
    id: fakeId(14),
    name: "c",
    type: 15,
    overwrites,
  });
  const overwrite = (
    id: string,
    type: number,
    allow: bigint,
    deny: bigint,
  ): PermissionOverwrite => ({ id, type, allow, deny });
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

  it("adds the member's roles to @everyone, and is undefined without it", () => {
    expect(permissionsWith([role(ROLE, VIEW)], channel())).toBeUndefined();
    expect(
      permissionsWith(
        [role(GUILD, 0n), role(ROLE, VIEW), role(OTHER_ROLE, SEND)],
        channel(),
        [ROLE],
      ),
    ).toBe(VIEW);
  });

  it("applies overwrites in order: @everyone, held roles, then the member", () => {
    const everyone = [role(GUILD, VIEW)];
    const allowedThenDenied = [
      overwrite(GUILD, 0, SEND, 0n),
      overwrite(ROLE, 0, 0n, SEND),
    ];

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
    expect(
      permissionsWith(
        [role(GUILD, 0n)],
        channel(overwrite(fakeId(15), 1, VIEW, 0n)),
      ),
    ).toBe(0n);
  });

  it("gives an administrator everything, and keeps high bits exact", () => {
    const administrator = permissionsWith(
      [role(GUILD, 0n), role(ROLE, PermissionFlagsBits.Administrator)],
      channel(overwrite(GUILD, 0, 0n, VIEW | SEND)),
      [ROLE],
    );
    const high = (1n << 54n) | 7n;

    expect(hasPermission(administrator ?? 0n, VIEW | SEND)).toBe(true);
    expect(permissionsWith([role(GUILD, high)], channel())).toBe(high);
  });

  it.each([
    ["the role grants it", VIEW, [], true],
    ["an overwrite denies it", VIEW, [overwrite(GUILD, 0, 0n, VIEW)], false],
    ["an overwrite allows it", 0n, [overwrite(GUILD, 0, VIEW, 0n)], true],
  ] as const)("lets @everyone view when %s", (_label, bits, list, expected) => {
    expect(everyoneCanView(GUILD, [role(GUILD, bits)], channel(...list))).toBe(
      expected,
    );
    expect(everyoneCanView(GUILD, [], channel())).toBeUndefined();
  });
});
