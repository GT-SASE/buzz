import {
  ApplicationIntegrationType,
  InteractionContextType,
} from "discord-api-types/v10";
import { describe, expect, it } from "bun:test";
import {
  parseAllowedGuildInteraction,
  type GuildInteraction,
} from "../discord/interactions.ts";
import { parseActor } from "./actor.ts";

const GUILD = "1".repeat(18);
const USER = "2".repeat(18);
const ROLE = "3".repeat(18);
const OTHER_ROLE = "4".repeat(19);
const APP = "5".repeat(18);

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

function actorWithPermissions(permissions: unknown) {
  return parseActor(interactionWith({ roles: [], permissions }));
}

describe("parseActor", () => {
  it("builds an Actor from the signed member", () => {
    const actor = parseActor(
      interactionWith({ roles: [ROLE, OTHER_ROLE], permissions: "0" }),
    );

    expect(actor).toEqual({
      userId: USER,
      guildId: GUILD,
      roleIds: new Set([ROLE, OTHER_ROLE]),
      isAdministrator: false,
    });
  });

  it.each([
    ["only Administrator", ADMINISTRATOR, true],
    ["Administrator with a bit above 2^53", (1n << 60n) | ADMINISTRATOR, true],
    ["the low bits next to it", 7n, false],
    // As a Number this rounds up to 2^54 + 8, which has the Administrator bit.
    ["2^54 + 7, which rounds onto the bit", (1n << 54n) | 7n, false],
  ])("reads the Administrator bit from %s", (_label, bits, expected) => {
    expect(actorWithPermissions(bits.toString())?.isAdministrator).toBe(
      expected,
    );
  });

  it.each([
    ["missing", undefined],
    // BigInt("") is 0n and does not throw.
    ["an empty string", ""],
    ["hex, which BigInt accepts", "0x8"],
    ["a negative value", "-8"],
    ["a JSON number", 8],
    ["40 digits", "8".repeat(40)],
  ])("refuses permissions that are %s", (_label, permissions) => {
    expect(actorWithPermissions(permissions)).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["a string", ROLE],
    ["one bad ID among good ones", [ROLE, OTHER_ROLE, "not-an-id"]],
  ])("refuses roles that are %s", (_label, roles) => {
    expect(
      parseActor(interactionWith({ roles, permissions: "8" })),
    ).toBeUndefined();
  });

  it("does not read fields from the prototype of a parsed payload", () => {
    const member = JSON.parse(
      `{"user":{"id":"${USER}"},"__proto__":{"roles":[],"permissions":"8"}}`,
    ) as Record<string, unknown>;

    expect(parseActor(interactionWith(member))).toBeUndefined();
  });

  it("is reached only through the parser, which refuses a bad user ID", () => {
    const interaction = {
      ...interactionWith({ roles: [], permissions: "0" }),
      member: { user: { id: "not-an-id" }, roles: [], permissions: "0" },
    };

    expect(
      parseAllowedGuildInteraction(interaction, {
        applicationId: APP,
        allowedGuildIds: new Set([GUILD]),
      }),
    ).toBeUndefined();
  });
});
