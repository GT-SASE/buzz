import { ApplicationCommandOptionType as Option } from "discord-api-types/v10";
import { describe, expect, it } from "bun:test";
import {
  commandOptionValue,
  resolvedChannel,
  resolvedPerson,
  resolvedRole,
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

  it("reads a channel and its guild", () => {
    expect(
      resolvedChannel(withResolved("channels", { [CHANNEL]: entry }), CHANNEL),
    ).toEqual({
      id: CHANNEL,
      type: 15,
      guildId: GUILD,
      appPermissions: undefined,
    });
  });

  it("keeps high app_permissions bits exactly, as a BigInt", () => {
    const high = 1n << 54n;

    expect(
      resolvedChannel(
        withResolved("channels", {
          [CHANNEL]: { ...entry, app_permissions: String(high) },
        }),
        CHANNEL,
      )?.appPermissions,
    ).toBe(high);
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
    ["bot false", { bot: false }, false],
    ["an odd system value", { system: 0 }, true],
  ])("reads %s", (_label, change, isBot) => {
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
