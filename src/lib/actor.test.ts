import {
  ApplicationIntegrationType,
  InteractionContextType,
} from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
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
const TWO_TO_53 = 1n << 53n;

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

  it("accepts a member with no roles", () => {
    expect(actorWithPermissions("0")?.roleIds.size).toBe(0);
  });

  describe("Administrator bit", () => {
    it.each([
      ["only Administrator", ADMINISTRATOR, true],
      ["Administrator among low bits", ADMINISTRATOR | 7n, true],
      [
        "Administrator with a bit above 2^53",
        (1n << 60n) | ADMINISTRATOR,
        true,
      ],
      ["Administrator with every bit to 2^64", (1n << 64n) - 1n, true],
      ["no bits", 0n, false],
      ["the low bits next to it", 7n, false],
      ["the bit above it", 1n << 4n, false],
      ["exactly 2^53", TWO_TO_53, false],
      // As a Number this rounds up to 2^54 + 8, which has the Administrator bit.
      ["2^54 + 7, which rounds onto the bit", (1n << 54n) | 7n, false],
      ["a high bit alone", 1n << 62n, false],
      [
        "every bit to 2^64 except Administrator",
        ((1n << 64n) - 1n) ^ ADMINISTRATOR,
        false,
      ],
    ])("reads %s", (_label, bits, expected) => {
      expect(actorWithPermissions(bits.toString())?.isAdministrator).toBe(
        expected,
      );
    });

    it("keeps the limit on length at 39 digits", () => {
      expect(actorWithPermissions("8".repeat(39))).toBeDefined();
      expect(actorWithPermissions("8".repeat(40))).toBeUndefined();
    });
  });

  describe("malformed permissions", () => {
    it.each([
      ["missing", undefined],
      ["null", null],
      // BigInt("") is 0n and does not throw.
      ["an empty string", ""],
      ["only spaces", "   "],
      ["surrounding spaces", " 8 "],
      ["a trailing newline", "8\n"],
      ["hex, which BigInt accepts", "0x8"],
      ["octal, which BigInt accepts", "0o10"],
      ["binary, which BigInt accepts", "0b1000"],
      ["a negative value", "-8"],
      ["a plus sign", "+8"],
      ["a BigInt literal suffix", "8n"],
      ["a decimal", "8.0"],
      ["an exponent", "1e3"],
      ["a leading zero", "08"],
      ["non-ASCII digits", "٨"],
      ["a JSON number", 8],
      ["a BigInt", 8n],
      ["a boolean", true],
      ["an array", ["8"]],
      ["an object", { valueOf: () => "8" }],
      ["constructor", "constructor"],
      ["toString", "toString"],
      ["__proto__", "__proto__"],
    ])("refuses %s", (_label, permissions) => {
      expect(actorWithPermissions(permissions)).toBeUndefined();
    });
  });

  describe("malformed roles", () => {
    it.each([
      ["missing", undefined],
      ["null", null],
      ["a string", ROLE],
      ["an object", { 0: ROLE, length: 1 }],
      ["a number in the list", [ROLE, 3]],
      ["null in the list", [null]],
      ["an empty string in the list", [""]],
      ["a short ID in the list", ["3".repeat(16)]],
      ["a nested list", [[ROLE]]],
      ["one bad ID among good ones", [ROLE, OTHER_ROLE, "not-an-id"]],
      ["constructor in the list", ["constructor"]],
      ["__proto__ in the list", ["__proto__"]],
    ])("refuses %s", (_label, roles) => {
      expect(
        parseActor(interactionWith({ roles, permissions: "8" })),
      ).toBeUndefined();
    });
  });

  it("does not read fields from the prototype of a parsed payload", () => {
    const member = JSON.parse(
      `{"user":{"id":"${USER}"},"__proto__":{"roles":[],"permissions":"8"}}`,
    ) as Record<string, unknown>;

    expect(parseActor(interactionWith(member))).toBeUndefined();
  });

  it("gives each payload its own roles, so removed roles are gone", () => {
    const before = parseActor(
      interactionWith({ roles: [ROLE], permissions: "0" }),
    );
    const after = parseActor(interactionWith({ roles: [], permissions: "0" }));

    expect(before?.roleIds.has(ROLE)).toBe(true);
    expect(after?.roleIds.has(ROLE)).toBe(false);
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
