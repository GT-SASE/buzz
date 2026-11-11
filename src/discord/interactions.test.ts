import { ApplicationCommandOptionType as Option } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import {
  commandOptionValue,
  commandPath,
  focusedOption,
  isComponentType,
  isOnEphemeralMessage,
  resolvedChannel,
  resolvedPerson,
  resolvedRole,
  selectedValues,
  type ChatInputCommand,
} from "./interactions.ts";

function fakeId(n: number): string {
  return String(10n ** 17n + BigInt(n));
}

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

  it.each(["__proto__", "constructor", "toString", "1"])(
    "finds nothing for the ID %s",
    (id) => {
      const entries = JSON.parse(
        `{"${id}": ${JSON.stringify({ ...roleEntry, id })}}`,
      ) as unknown;

      expect(resolvedRole(withResolved("roles", entries), id)).toBeUndefined();
    },
  );

  it("does not read an entry inherited through the prototype", () => {
    const entries = Object.create({ [ROLE]: roleEntry }) as unknown;

    expect(resolvedRole(withResolved("roles", entries), ROLE)).toBeUndefined();
  });

  it("refuses an entry filed under another role's ID", () => {
    const entries = { [ROLE]: { ...roleEntry, id: fakeId(9) } };

    expect(resolvedRole(withResolved("roles", entries), ROLE)).toBeUndefined();
  });

  it.each([
    ["no name", { name: undefined }],
    ["a name that is not text", { name: 1 }],
    ["managed that is not a boolean", { managed: "false" }],
    ["no position", { position: undefined }],
    ["empty permissions", { permissions: "" }],
    ["hex permissions", { permissions: "0x8" }],
    ["numeric permissions", { permissions: 8 }],
  ])("refuses %s", (_label, change) => {
    const entries = { [ROLE]: { ...roleEntry, ...change } };

    expect(resolvedRole(withResolved("roles", entries), ROLE)).toBeUndefined();
  });

  it.each([null, 1, [], {}, { data: null }, { data: { resolved: [] } }])(
    "finds nothing in the payload %j",
    (payload) => {
      expect(resolvedRole(payload, ROLE)).toBeUndefined();
    },
  );
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

  it("leaves the guild undefined when Discord leaves it out", () => {
    expect(
      resolvedChannel(
        withResolved("channels", { [CHANNEL]: { id: CHANNEL, type: 15 } }),
        CHANNEL,
      ),
    ).toEqual({
      id: CHANNEL,
      type: 15,
      guildId: undefined,
      appPermissions: undefined,
    });
  });

  it.each([
    ["a type that is not a number", { type: "15" }],
    ["a malformed guild", { guild_id: "x" }],
    ["empty app_permissions", { app_permissions: "" }],
    ["hex app_permissions", { app_permissions: "0x8" }],
    ["numeric app_permissions", { app_permissions: 8 }],
  ])("refuses %s", (_label, change) => {
    expect(
      resolvedChannel(
        withResolved("channels", { [CHANNEL]: { ...entry, ...change } }),
        CHANNEL,
      ),
    ).toBeUndefined();
  });
});

describe("resolvedChannel app_permissions", () => {
  it("keeps high bits exactly, as a BigInt", () => {
    const high = 1n << 54n;

    expect(
      resolvedChannel(
        withResolved("channels", {
          [CHANNEL]: { id: CHANNEL, type: 15, app_permissions: String(high) },
        }),
        CHANNEL,
      )?.appPermissions,
    ).toBe(high);
  });
});

describe("resolvedPerson", () => {
  const PERSON = fakeId(4);
  const user = { id: PERSON, username: "someone" };
  const payload = (resolved: unknown) => ({ data: { resolved } });
  const members = { [PERSON]: { roles: [] } };

  it("reads a member of the guild", () => {
    expect(
      resolvedPerson(payload({ users: { [PERSON]: user }, members }), PERSON),
    ).toEqual({ id: PERSON, isMember: true, isBot: false });
  });

  it("tells a user who is not in the guild apart", () => {
    expect(
      resolvedPerson(payload({ users: { [PERSON]: user } }), PERSON)?.isMember,
    ).toBe(false);
  });

  it.each([
    ["bot true", { bot: true }, true],
    ["system true", { system: true }, true],
    ["bot false", { bot: false }, false],
    ["an odd bot value", { bot: "no" }, true],
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
    ["no resolved data", {}, PERSON],
    ["no user entry", payload({ members }), PERSON],
    [
      "a mismatched entry",
      payload({ users: { [PERSON]: { id: GUILD } } }),
      PERSON,
    ],
    ["a malformed ID", payload({ users: { x: { id: "x" } } }), "x"],
    ["a key on the prototype", payload({ users: {} }), "__proto__"],
    [
      "a user that is not an object",
      payload({ users: { [PERSON]: "x" } }),
      PERSON,
    ],
  ])("finds nothing for %s", (_label, value, id) => {
    expect(resolvedPerson(value, id)).toBeUndefined();
  });

  it("does not count a member entry from the prototype", () => {
    const person = resolvedPerson(
      payload({ users: { [PERSON]: user }, members: {} }),
      PERSON,
    );
    expect(person?.isMember).toBe(false);
  });
});

describe("commandPath", () => {
  const command = (options?: unknown) =>
    ({ data: { name: "event", options } }) as unknown as ChatInputCommand;

  it("is the name with no subcommand", () => {
    expect(commandPath(command())).toBe("event");
    expect(commandPath(command([{ type: Option.String, name: "x" }]))).toBe(
      "event",
    );
  });

  it("adds a subcommand", () => {
    expect(
      commandPath(command([{ type: Option.Subcommand, name: "close" }])),
    ).toBe("event close");
  });

  it("has no path for a group or a subcommand with no name", () => {
    expect(
      commandPath(command([{ type: Option.SubcommandGroup, name: "x" }])),
    ).toBeUndefined();
    expect(commandPath(command([{ type: Option.Subcommand }]))).toBeUndefined();
  });

  it("ignores options that are too many to be real", () => {
    const many = Array.from({ length: 26 }, () => ({
      type: Option.Subcommand,
      name: "x",
    }));

    expect(commandPath(command(many))).toBe("event");
  });
});

describe("commandOptionValue", () => {
  const withOptions = (options: unknown) => ({ data: { options } });

  it("reads one option of the right name and type", () => {
    const payload = withOptions([
      { name: "role", type: Option.Role, value: ROLE },
    ]);

    expect(commandOptionValue(payload, "role", Option.Role)).toBe(ROLE);
  });

  it("reads inside a subcommand", () => {
    const payload = withOptions([
      {
        name: "sub",
        type: Option.Subcommand,
        options: [{ name: "role", type: Option.Role, value: ROLE }],
      },
    ]);

    expect(commandOptionValue(payload, "role", Option.Role)).toBe(ROLE);
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
    ["another name", [{ name: "x", type: Option.Role, value: ROLE }]],
    ["no list", "role"],
  ])("finds nothing with %s", (_label, options) => {
    expect(
      commandOptionValue(withOptions(options), "role", Option.Role),
    ).toBeUndefined();
  });
});

describe("focusedOption", () => {
  it("reads the one focused option", () => {
    expect(
      focusedOption({
        data: {
          options: [
            { name: "a", value: "1" },
            { name: "b", value: "2", focused: true },
          ],
        },
      }),
    ).toEqual({ name: "b", value: "2" });
  });

  it.each([
    [[]],
    [[{ name: "a", value: "1", focused: "true" }]],
    [[{ name: "a", value: 1, focused: true }]],
    [
      [
        { name: "a", value: "1", focused: true },
        { name: "b", value: "2", focused: true },
      ],
    ],
  ])("finds nothing in %j", (options) => {
    expect(focusedOption({ data: { options } })).toBeUndefined();
  });
});

describe("selectedValues", () => {
  it("reads a list of strings", () => {
    expect(selectedValues({ data: { values: ["a", "b"] } })).toEqual([
      "a",
      "b",
    ]);
  });

  it.each([
    ["no list", "a"],
    ["a value that is not text", ["a", 1]],
    ["more than a select allows", Array.from({ length: 26 }, () => "a")],
  ])("refuses %s", (_label, values) => {
    expect(selectedValues({ data: { values } })).toBeUndefined();
  });
});

describe("small readers", () => {
  it("compares the component type exactly", () => {
    expect(isComponentType({ data: { component_type: 8 } }, 8)).toBe(true);
    expect(isComponentType({ data: { component_type: "8" } }, 8)).toBe(false);
    expect(isComponentType({}, 8)).toBe(false);
  });

  it.each([
    [64, true],
    [64 + 4, true],
    [4, false],
    ["64", false],
    [undefined, false],
  ])("treats message flags %j as ephemeral: %s", (flags, expected) => {
    expect(isOnEphemeralMessage({ message: { flags } })).toBe(expected);
  });
});
