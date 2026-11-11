import {
  ApplicationCommandOptionType,
  InteractionResponseType,
  MessageFlags,
} from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN,
  ADMIN_ROLE,
  ADMINISTRATOR,
  commandPayload,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDb,
  fakeDiscord,
  GUILD_ID,
  member,
  MEMBER_ID,
  OFFICER,
  OFFICER_ROLE,
  PLAIN_MEMBER,
  run,
  type FakeDiscordData,
} from "../../test/support/interactions.ts";
import { testSnowflake } from "../../test/support/mock-postgrest.ts";
import type { GuildRole } from "../discord/client.ts";
import { REFUSED } from "../lib/permissions.ts";
import { COMMANDS, ROUTER } from "./registry.ts";
import { rolesThatMayGrant } from "./setup.ts";

const ADMINISTRATOR_BIT = 1n << 3n;
const MANAGE_ROLES_BIT = 1n << 28n;

const NEW_OFFICER = testSnowflake();
const NEW_ADMIN = testSnowflake();

function role(id: string, fields: Partial<GuildRole> = {}): GuildRole {
  return {
    id,
    name: `Role ${id}`,
    permissions: 0n,
    position: 5,
    managed: false,
    ...fields,
  };
}

function resolvedEntry(guildRole: GuildRole) {
  return { ...guildRole, permissions: String(guildRole.permissions) };
}

function setupPayload(
  officer: GuildRole,
  admin: GuildRole,
  fields: Record<string, unknown> = {},
  extraOptions: unknown[] = [],
) {
  return commandPayload("setup", fields, {
    options: [
      {
        name: "officer_role",
        type: ApplicationCommandOptionType.Role,
        value: officer.id,
      },
      {
        name: "admin_role",
        type: ApplicationCommandOptionType.Role,
        value: admin.id,
      },
      ...extraOptions,
    ],
    resolved: {
      roles: {
        [officer.id]: resolvedEntry(officer),
        [admin.id]: resolvedEntry(admin),
      },
    },
  });
}

const OFFICER_ENTRY = role(NEW_OFFICER, { name: "Officers" });
const ADMIN_ENTRY = role(NEW_ADMIN, { name: "Admins" });
const ROLE_LIST = [
  role(GUILD_ID, { name: "@everyone", position: 0 }),
  OFFICER_ENTRY,
  ADMIN_ENTRY,
];

function world(
  fields: Parameters<typeof fakeDb>[0] = {},
  discordData: FakeDiscordData = { roles: ROLE_LIST },
) {
  const database = fakeDb(fields);
  const { discord, edits } = fakeDiscord(discordData);
  return {
    ...database,
    edits,
    dependencies: dependenciesFor(database.db, discord),
  };
}

function customIdIn(edit: { components?: unknown[] } | undefined): string {
  const [row] = (edit?.components ?? []) as {
    components: { custom_id: string }[];
  }[];
  return row?.components[0]?.custom_id ?? "";
}

const FIXED_REFUSAL_TEXT = REFUSED.message;

const logged = vi.fn();

beforeEach(() => {
  logged.mockReset();
  vi.spyOn(console, "error").mockImplementation(logged);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration", () => {
  const definition = (
    COMMANDS as readonly {
      name: string;
      default_member_permissions?: string;
      options?: readonly { name: string; type: number; required?: boolean }[];
    }[]
  ).find((command) => command.name === "setup");

  it("is hidden by default, top level, with two required role options", () => {
    expect(definition?.default_member_permissions).toBe("0");
    expect(
      definition?.options?.map(({ name, type, required }) => [
        name,
        type,
        required,
      ]),
    ).toEqual([
      ["officer_role", ApplicationCommandOptionType.Role, true],
      ["admin_role", ApplicationCommandOptionType.Role, true],
    ]);
  });
});

describe("/setup", () => {
  it("defers privately and shows the roles and a Confirm button", async () => {
    const { dependencies, edits } = world();

    const { reply } = await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY),
      dependencies,
    );

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toContain("Officer role: Officers");
    expect(edits[0]?.content).toContain("Admin role: Admins");
    expect(customIdIn(edits[0])).toBe(
      `setup.confirm:0:${NEW_OFFICER}:${NEW_ADMIN}`,
    );
  });

  it("carries the current version in Confirm", async () => {
    const { dependencies, edits } = world({
      config: configRow({ version: 7 }),
    });

    await run(ROUTER, setupPayload(OFFICER_ENTRY, ADMIN_ENTRY), dependencies);

    expect(customIdIn(edits[0])).toContain("setup.confirm:7:");
  });

  it("never says that nobody else can grant a role", async () => {
    const { dependencies, edits } = world();

    await run(ROUTER, setupPayload(OFFICER_ENTRY, ADMIN_ENTRY), dependencies);

    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant this: none found. The server owner may also be able to.",
    );
    expect(edits[0]?.content).not.toMatch(/\bonly\b/i);
  });

  it("writes nothing before Confirm", async () => {
    const { dependencies, rpcBodies, state } = world();

    await run(ROUTER, setupPayload(OFFICER_ENTRY, ADMIN_ENTRY), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(state.config).toBeNull();
  });

  it.each([
    ["a plain member", PLAIN_MEMBER],
    ["an officer", OFFICER],
    ["the bound admin role, which does not reach bindings", ADMIN],
  ])("refuses %s, with no reply content", async (_label, who) => {
    const { dependencies, edits } = world({ config: configRow() });

    const { reply, deferred } = await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY, { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(deferred).toBe(false);
    expect(edits).toEqual([]);
  });

  it("refuses a non-admin before setup too", async () => {
    const { dependencies } = world();

    const { reply } = await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY, { member: PLAIN_MEMBER }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
  });

  it("does not take high permission bits for Administrator", async () => {
    const { dependencies } = world();

    const { reply } = await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY, {
        member: member({ permissions: String((1n << 54n) | 7n) }),
      }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
  });

  it("allows an administrator to rebind when the bound roles are gone", async () => {
    const { dependencies, edits } = world({
      config: configRow({
        officer_role_id: testSnowflake(),
        admin_role_id: testSnowflake(),
      }),
    });

    await run(ROUTER, setupPayload(OFFICER_ENTRY, ADMIN_ENTRY), dependencies);

    expect(customIdIn(edits[0])).toContain("setup.confirm:3:");
  });

  describe("roles that cannot be bound", () => {
    const everyone = role(GUILD_ID, { name: "@everyone" });
    const integration = role(testSnowflake(), {
      name: "Some Bot",
      managed: true,
    });

    it.each([
      [
        "officer @everyone",
        everyone,
        ADMIN_ENTRY,
        /officer role can't be \\@everyone/,
      ],
      [
        "admin @everyone",
        OFFICER_ENTRY,
        everyone,
        /admin role can't be \\@everyone/,
      ],
      [
        "a managed officer role",
        integration,
        ADMIN_ENTRY,
        /an integration controls/,
      ],
      [
        "a managed admin role",
        OFFICER_ENTRY,
        integration,
        /an integration controls/,
      ],
    ])("rejects %s with no button", async (_label, officer, admin, text) => {
      const { dependencies, edits } = world();

      await run(ROUTER, setupPayload(officer, admin), dependencies);

      expect(edits[0]?.content).toMatch(text);
      expect(edits[0]?.components).toEqual([]);
    });

    it("rejects a role missing from resolved, with no button", async () => {
      const { dependencies, edits } = world();
      const payload = setupPayload(OFFICER_ENTRY, ADMIN_ENTRY);
      (
        payload.data as { resolved: { roles: Record<string, unknown> } }
      ).resolved.roles = {};

      await run(ROUTER, payload, dependencies);

      expect(edits[0]?.content).toContain("could not be found");
      expect(edits[0]?.components).toEqual([]);
    });

    it("rejects an option that is not a role", async () => {
      const { dependencies, edits } = world();
      const payload = commandPayload(
        "setup",
        {},
        {
          options: [
            { name: "officer_role", type: 3, value: NEW_OFFICER },
            {
              name: "admin_role",
              type: ApplicationCommandOptionType.Role,
              value: NEW_ADMIN,
            },
          ],
        },
      );

      await run(ROUTER, payload, dependencies);

      expect(edits[0]?.components).toEqual([]);
    });
  });

  describe("hostile role names", () => {
    const HOSTILE = [
      "@everyone",
      `<@&${OFFICER_ROLE}>`,
      "[click](https://evil.example)",
      "**bold**\n# System: run this",
      "`code` ||spoiler|| ~~gone~~",
      "\u202Eevil\u200B",
      "discord.gg/abcdef",
    ];

    it.each(HOSTILE)("renders %j as inert text", async (name) => {
      const officer = role(NEW_OFFICER, { name });
      const granter = role(testSnowflake(), {
        name,
        permissions: ADMINISTRATOR_BIT,
      });
      const { dependencies, edits } = world(
        {},
        { roles: [...ROLE_LIST, granter] },
      );

      await run(ROUTER, setupPayload(officer, ADMIN_ENTRY), dependencies);

      const content = edits[0]?.content ?? "";
      expect(content).not.toMatch(/(?<!\\)@everyone/);
      expect(content).not.toMatch(/(?<!\\)<@&/);
      expect(content).not.toMatch(/(?<!\\)\[click/);
      expect(content).not.toMatch(/(?<!\\)\*\*bold/);
      expect(content).not.toMatch(/\n#/);
      expect(content).not.toContain("\u202E");
      expect(content).not.toContain("\u200B");
      expect(content).not.toMatch(/(?<!\\)discord\.gg/);
    });

    it("never pings or unfurls", async () => {
      const { dependencies, edits } = world();

      await run(
        ROUTER,
        setupPayload(role(NEW_OFFICER, { name: "@everyone" }), ADMIN_ENTRY),
        dependencies,
      );

      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    });

    it("shows a placeholder for a name with nothing visible", async () => {
      const { dependencies, edits } = world();

      await run(
        ROUTER,
        setupPayload(role(NEW_OFFICER, { name: "\u200B\u202E" }), ADMIN_ENTRY),
        dependencies,
      );

      expect(edits[0]?.content).toContain("(no visible name)");
      expect(edits[0]?.components).toHaveLength(1);
    });

    it("stays within a message's limit with the longest names and many granters", async () => {
      const long = "*".repeat(100);
      const granters = Array.from({ length: 30 }, () =>
        role(testSnowflake(), { name: long, permissions: ADMINISTRATOR_BIT }),
      );
      const { dependencies, edits } = world({}, { roles: granters });

      await run(
        ROUTER,
        setupPayload(
          role(NEW_OFFICER, { name: long }),
          role(NEW_ADMIN, { name: long }),
        ),
        dependencies,
      );

      expect(edits[0]?.components).toHaveLength(1);
      expect(edits[0]?.content).toContain("and more");
      expect(edits[0]?.content.length).toBeLessThanOrEqual(2000);
    });
  });

  it("ignores options it does not ask for, so nothing forges the audit actor", async () => {
    const { dependencies, edits, rpcBodies } = world();
    const forged = testSnowflake();

    await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY, {}, [
        { name: "p_actor_id", type: 3, value: forged },
        { name: "p_guild_id", type: 3, value: forged },
        { name: "guildId", type: 3, value: forged },
      ]),
      dependencies,
    );
    await run(
      ROUTER,
      componentPayload(customIdIn(edits[0]), { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(rpcBodies("apply_role_bindings")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 0,
        p_actor_id: MEMBER_ID,
        p_officer_role_id: NEW_OFFICER,
        p_admin_role_id: NEW_ADMIN,
      },
    ]);
  });

  it("says who could grant a role, and that it could not check when the lookup fails", async () => {
    const manager = role(testSnowflake(), {
      name: "Mods",
      permissions: MANAGE_ROLES_BIT,
      position: 9,
    });
    const { dependencies, edits } = world(
      {},
      { roles: [...ROLE_LIST, manager] },
    );
    const failing = world({}, { roles: "fail" });

    await run(ROUTER, setupPayload(OFFICER_ENTRY, ADMIN_ENTRY), dependencies);
    await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY),
      failing.dependencies,
    );

    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant this: Mods. The server owner may also be able to.",
    );
    expect(failing.edits[0]?.content).toContain("could not check");
    expect(failing.edits[0]?.components).toHaveLength(1);
    expect(JSON.stringify(failing.edits)).not.toContain("canary");
  });
});

describe("rolesThatMayGrant", () => {
  it.each([
    ["Administrator below", ADMINISTRATOR_BIT, 1, true],
    ["Administrator above", ADMINISTRATOR_BIT, 9, true],
    ["Manage Roles above", MANAGE_ROLES_BIT, 6, true],
    ["Manage Roles below", MANAGE_ROLES_BIT, 4, true],
    ["neither", 1n << 10n, 9, false],
  ])("%s", (_label, permissions, position, expected) => {
    expect(
      rolesThatMayGrant([role(testSnowflake(), { permissions, position })]),
    ).toHaveLength(expected ? 1 : 0);
  });

  it("includes the chosen role itself, and lists the highest first", () => {
    const low = role(NEW_OFFICER, {
      permissions: MANAGE_ROLES_BIT,
      position: 2,
    });
    const high = role(testSnowflake(), {
      permissions: ADMINISTRATOR_BIT,
      position: 8,
    });

    expect(rolesThatMayGrant([low, high])).toEqual([high, low]);
  });

  it("does not round high bits into Manage Roles", () => {
    expect(
      rolesThatMayGrant([
        role(testSnowflake(), { permissions: (1n << 54n) | 7n, position: 9 }),
      ]),
    ).toEqual([]);
  });
});

describe("Confirm", () => {
  const confirmId = (version = 0) =>
    `setup.confirm:${String(version)}:${NEW_OFFICER}:${NEW_ADMIN}`;

  it("saves from the signed payload and the role IDs it carries", async () => {
    const { dependencies, edits, rpcBodies, state } = world();

    await run(ROUTER, componentPayload(confirmId()), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 0,
        p_actor_id: MEMBER_ID,
        p_officer_role_id: NEW_OFFICER,
        p_admin_role_id: NEW_ADMIN,
      },
    ]);
    expect(state.config?.officer_role_id).toBe(NEW_OFFICER);
    expect(edits[0]?.content).toContain("Saved.");
    expect(edits[0]?.components).toEqual([]);
  });

  it.each([
    ["a plain member", PLAIN_MEMBER],
    ["an officer", OFFICER],
    ["the bound admin role", ADMIN],
    ["a former administrator", member()],
  ])("refuses %s, even with a copied button", async (_label, who) => {
    const { dependencies, rpcBodies, edits } = world({ config: configRow() });

    const { reply } = await run(
      ROUTER,
      componentPayload(confirmId(3), { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(edits).toEqual([]);
  });

  it("refuses a Confirm on a message that is not private", async () => {
    const { dependencies, rpcBodies } = world();

    const { reply } = await run(
      ROUTER,
      componentPayload(confirmId(), { message: { flags: 0 } }),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(rpcBodies("apply_role_bindings")).toEqual([]);
  });

  it("gives a replayed Confirm no second write", async () => {
    const { dependencies, rpcBodies, edits } = world();
    const payload = componentPayload(confirmId());

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(rpcBodies("apply_role_bindings")).toHaveLength(1);
    expect(edits).toHaveLength(1);
  });

  it("refuses with a refresh message when someone saved first", async () => {
    const { dependencies, rpcBodies, edits } = world({
      config: configRow({ version: 4 }),
    });

    await run(ROUTER, componentPayload(confirmId(3)), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("Someone else changed the roles");
    expect(edits[0]?.components).toEqual([]);
  });

  it("refuses with the same refresh message when the database says stale", async () => {
    const { dependencies, edits, state } = world({
      config: configRow({ version: 3 }),
    });
    state.failing = {
      path: "apply_role_bindings",
      status: 400,
      code: "CF409",
    };

    await run(ROUTER, componentPayload(confirmId(3)), dependencies);

    expect(edits[0]?.content).toContain("Someone else changed the roles");
    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it("lets exactly one of two racing admins win", async () => {
    const { dependencies, edits, rpcBodies, state } = world({
      config: configRow({ version: 3 }),
    });
    const first = componentPayload(confirmId(3));
    const second = componentPayload(confirmId(3));

    await Promise.all([
      run(ROUTER, first, dependencies),
      run(ROUTER, second, dependencies),
    ]);

    expect(state.config?.version).toBe(4);
    const texts = edits.map((edit) => edit.content);
    expect(texts.filter((text) => text.includes("Saved."))).toHaveLength(1);
    expect(
      texts.filter((text) => text.includes("Someone else changed the roles")),
    ).toHaveLength(1);
    expect(rpcBodies("claim_interaction")).toHaveLength(2);
  });

  it("refuses a role deleted since the panel opened", async () => {
    const { dependencies, edits, rpcBodies } = world(
      {},
      { roles: [role(GUILD_ID), ADMIN_ENTRY] },
    );

    await run(ROUTER, componentPayload(confirmId()), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("nothing was changed");
    expect(edits[0]?.components).toEqual([]);
  });

  it("refuses a role that became managed since the panel opened", async () => {
    const { dependencies, edits, rpcBodies } = world(
      {},
      {
        roles: [
          role(GUILD_ID),
          role(NEW_OFFICER, { managed: true }),
          ADMIN_ENTRY,
        ],
      },
    );

    await run(ROUTER, componentPayload(confirmId()), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("an integration controls");
  });

  it("refuses @everyone in a crafted Confirm", async () => {
    const { dependencies, edits, rpcBodies } = world();

    await run(
      ROUTER,
      componentPayload(`setup.confirm:0:${GUILD_ID}:${NEW_ADMIN}`),
      dependencies,
    );

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("can't be \\@everyone");
  });

  it("refuses to save when Discord can't confirm the roles", async () => {
    const { dependencies, edits, rpcBodies } = world({}, { roles: "fail" });

    await run(ROUTER, componentPayload(confirmId()), dependencies);

    expect(rpcBodies("apply_role_bindings")).toEqual([]);
    expect(edits[0]?.content).toContain("nothing was changed");
    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it.each([
    ["an extra separator", `setup.confirm:0:${NEW_OFFICER}:${NEW_ADMIN}:1`],
    ["a role name in place of an ID", `setup.confirm:0:admin:${NEW_ADMIN}`],
    [
      "authority in the ID",
      `setup.confirm:0:${NEW_OFFICER}:${NEW_ADMIN}:admin`,
    ],
    ["a missing version", `setup.confirm:${NEW_OFFICER}:${NEW_ADMIN}`],
  ])("refuses %s", async (_label, customId) => {
    const { dependencies, rpcBodies } = world();

    const { reply } = await run(
      ROUTER,
      componentPayload(customId),
      dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(rpcBodies("apply_role_bindings")).toEqual([]);
  });

  it("says try again, with no database text, when the save fails", async () => {
    const { dependencies, edits, state } = world();
    state.failing = { path: "apply_role_bindings", status: 503 };

    await run(ROUTER, componentPayload(confirmId()), dependencies);

    expect(edits[0]?.content).toContain("Something went wrong");
    expect(JSON.stringify(edits)).not.toContain("canary");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
  });

  it("shows no nickname anywhere, whatever the payload holds", async () => {
    const { dependencies, edits } = world();
    const hostile = "canary-nick";

    await run(
      ROUTER,
      setupPayload(OFFICER_ENTRY, ADMIN_ENTRY, {
        member: {
          ...ADMINISTRATOR,
          nick: hostile,
          user: {
            id: MEMBER_ID,
            username: hostile,
            global_name: hostile,
          },
        },
      }),
      dependencies,
    );

    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it("leaves the existing bindings in place after a refusal", async () => {
    const { dependencies, state } = world({
      config: configRow({ version: 9 }),
    });

    await run(ROUTER, componentPayload(confirmId(3)), dependencies);

    expect(state.config?.officer_role_id).toBe(OFFICER_ROLE);
    expect(state.config?.admin_role_id).toBe(ADMIN_ROLE);
  });
});
