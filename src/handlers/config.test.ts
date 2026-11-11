import {
  InteractionResponseType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN,
  ADMINISTRATOR,
  APP_ID,
  commandPayload,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDb,
  fakeDiscord,
  GUILD_ID,
  managedRow,
  member,
  MEMBER_ID,
  OFFICER,
  PLAIN_MEMBER,
  run,
  type ChangeRow,
  type FakeDiscordData,
} from "../../test/support/interactions.ts";
import { testSnowflake } from "../../test/support/mock-postgrest.ts";
import type {
  DiscordClient,
  GuildChannel,
  GuildRole,
} from "../discord/client.ts";
import { REFUSED } from "../lib/permissions.ts";
import { COMMANDS, ROUTER } from "./registry.ts";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const SEND_IN_THREADS = PermissionFlagsBits.SendMessagesInThreads;
const ALL_NEEDED = VIEW | SEND | SEND_IN_THREADS;

const FORUM = testSnowflake();
const NEW_FORUM = testSnowflake();
const TEXT_CHANNEL = testSnowflake();
const BOT_ROLE = testSnowflake();

function role(id: string, permissions = 0n): GuildRole {
  return { id, name: "Role", permissions, position: 1, managed: false };
}

/** A private forum where the bot's own role has been granted what it needs. */
function forum(id: string, fields: Partial<GuildChannel> = {}): GuildChannel {
  return {
    id,
    name: "events",
    type: 15,
    overwrites: [
      { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
      { id: BOT_ROLE, type: 0, allow: ALL_NEEDED, deny: 0n },
    ],
    ...fields,
  };
}

const ROLES = [role(GUILD_ID, VIEW), role(BOT_ROLE)];
const CHANNELS = [
  forum(FORUM),
  forum(NEW_FORUM),
  { ...forum(TEXT_CHANNEL), type: 0 },
];

function world(
  fields: Parameters<typeof fakeDb>[0] = {},
  discordData: FakeDiscordData = {},
) {
  const database = fakeDb({
    config: configRow(),
    channels: [managedRow(FORUM)],
    ...fields,
  });
  const { discord, edits } = fakeDiscord({
    roles: ROLES,
    channels: CHANNELS,
    botRoleIds: [BOT_ROLE],
    ...discordData,
  });
  return {
    ...database,
    edits,
    dependencies: dependenciesFor(database.db, discord),
  };
}

interface Component {
  type: number;
  custom_id: string;
  label?: string;
  channel_types?: number[];
  default_values?: unknown;
  options?: { label: string; value: string }[];
}

function componentsOf(edit: { components?: unknown[] } | undefined) {
  return ((edit?.components ?? []) as { components: Component[] }[]).flatMap(
    (row) => row.components,
  );
}

function customIds(edit: { components?: unknown[] } | undefined): string[] {
  return componentsOf(edit).map((component) => component.custom_id);
}

function addPayload(
  channelId: string,
  fields: Record<string, unknown> = {},
  version = 3,
  channel: Record<string, unknown> = { id: channelId, type: 15 },
) {
  return componentPayload(`config.add:${String(version)}`, fields, {
    component_type: 8,
    values: [channelId],
    resolved: { channels: { [channelId]: channel } },
  });
}

function removePayload(
  channelId: unknown,
  fields: Record<string, unknown> = {},
  version = 3,
) {
  return componentPayload(`config.remove:${String(version)}`, fields, {
    component_type: 3,
    values: [channelId],
  });
}

function change(fields: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: 1,
    actor_id: testSnowflake(),
    action: "settings",
    old_values: { reminders_enabled: true, active_channel_ids: [] },
    new_values: { reminders_enabled: true, active_channel_ids: [FORUM] },
    version_after: 2,
    created_at: "2030-01-02T03:04:05.000Z",
    ...fields,
  };
}

const logged = vi.fn();

beforeEach(() => {
  logged.mockReset();
  vi.spyOn(console, "error").mockImplementation(logged);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registration", () => {
  it("registers /config with no options, for the server-side check to decide", () => {
    const definition = (
      COMMANDS as readonly {
        name: string;
        default_member_permissions?: string;
        options?: unknown;
      }[]
    ).find((command) => command.name === "config");

    expect(definition).toBeDefined();
    expect(definition?.options).toBeUndefined();
    expect(definition?.default_member_permissions).toBeUndefined();
  });
});

describe("/config", () => {
  it("defers privately and draws the panel", async () => {
    const { dependencies, edits } = world();

    const { reply } = await run(ROUTER, commandPayload("config"), dependencies);

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(edits[0]?.content).toContain("Reminders: **on**");
    expect(edits[0]?.content).toContain(`<#${FORUM}>`);
    expect(customIds(edits[0])).toEqual([
      "config.add:3",
      "config.reminders-off:3",
      "config.view",
      "config.remove:3",
    ]);
  });

  it.each([
    ["the admin role", ADMIN],
    ["the Administrator bit", ADMINISTRATOR],
  ])("opens for %s", async (_label, who) => {
    const { dependencies, edits } = world();

    await run(ROUTER, commandPayload("config", { member: who }), dependencies);

    expect(edits).toHaveLength(1);
  });

  it.each([
    ["a member", PLAIN_MEMBER],
    ["an officer", OFFICER],
  ])("refuses %s with the fixed reply", async (_label, who) => {
    const { dependencies, edits } = world();

    const { reply, deferred } = await run(
      ROUTER,
      commandPayload("config", { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
    expect(deferred).toBe(false);
    expect(edits).toEqual([]);
  });

  it("refuses before setup, even for an administrator", async () => {
    const { dependencies } = world({ config: null });

    const { reply } = await run(
      ROUTER,
      commandPayload("config", { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
  });

  it("limits the channel select to forums, with no default values", async () => {
    const { dependencies, edits } = world();

    await run(ROUTER, commandPayload("config"), dependencies);

    const [select] = componentsOf(edits[0]);
    expect(select?.channel_types).toEqual([15]);
    expect(select?.default_values).toBeUndefined();
  });

  it("shows the switch that does the opposite of the current state", async () => {
    const off = world({ config: configRow({ reminders_enabled: false }) });

    await run(ROUTER, commandPayload("config"), off.dependencies);

    expect(off.edits[0]?.content).toContain("Reminders: **off**");
    expect(customIds(off.edits[0])).toContain("config.reminders-on:3");
    expect(customIds(off.edits[0])).not.toContain("config.reminders-off:3");
  });

  it("leaves out the removal select when no forum is managed", async () => {
    const { dependencies, edits } = world({ channels: [] });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("None yet.");
    expect(customIds(edits[0])).toEqual([
      "config.add:3",
      "config.reminders-off:3",
      "config.view",
    ]);
  });

  it("does not list a removed forum", async () => {
    const { dependencies, edits } = world({
      channels: [managedRow(FORUM, "removed")],
    });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).not.toContain(FORUM);
  });

  describe("what Discord says about a managed forum", () => {
    it("warns when @everyone can view it", async () => {
      const { dependencies, edits } = world(
        {},
        { channels: [forum(FORUM, { overwrites: [] })] },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(
        `<#${FORUM}>: \\@everyone can view this forum`,
      );
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
      });
    });

    it("does not warn when an overwrite hides it", async () => {
      const { dependencies, edits } = world();

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).not.toContain("can view this forum");
    });

    it("does not guess when the roles can't be read", async () => {
      const { dependencies, edits } = world(
        {},
        { channels: [forum(FORUM, { overwrites: [] })], roles: "fail" },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).not.toContain("can view this forum");
      expect(customIds(edits[0])).toContain("config.remove:3");
    });

    it("keeps working when a managed forum was deleted, and offers its removal", async () => {
      const { dependencies, edits } = world({}, { channels: [] });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<#${FORUM}>: deleted from Discord`);
      const remove = componentsOf(edits[0]).at(-1);
      expect(remove?.options).toEqual([
        { label: `Forum ${FORUM}`, value: FORUM },
      ]);
    });

    it.each<[string, FakeDiscordData]>([
      ["is gone from the channel list", { channels: [] }],
      ["can't be checked", { channels: "fail" }],
    ])(
      "calls an unavailable forum deleted when it %s",
      async (_label, discordData) => {
        const { dependencies, edits } = world(
          { channels: [managedRow(FORUM, "unavailable")] },
          discordData,
        );

        await run(ROUTER, commandPayload("config"), dependencies);

        expect(edits[0]?.content).toContain(
          `<#${FORUM}>: deleted from Discord`,
        );
        expect(edits[0]?.content).not.toContain("lost access");
        expect(customIds(edits[0])).toContain("config.remove:3");
      },
    );

    it("says an unavailable forum can be added again if Discord lists it", async () => {
      const { dependencies, edits } = world({
        channels: [managedRow(FORUM, "unavailable")],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain("Add it again to resume");
      expect(edits[0]?.content).not.toContain("lost access");
    });

    it("fits the longest panel in one message", async () => {
      const forums = Array.from({ length: 20 }, () => testSnowflake());
      const long = (id: string) => id.padEnd(20, "0");
      const { dependencies, edits } = world(
        {
          config: configRow({ reminders_enabled: true }),
          channels: forums.map((id) => managedRow(long(id), "unavailable")),
          changes: Array.from({ length: 5 }, (_, id) =>
            change({
              id,
              actor_id: long(testSnowflake()),
              new_values: {
                reminders_enabled: true,
                removed_channel_ids: [long(testSnowflake())],
              },
            }),
          ),
        },
        { channels: "fail" },
      );

      await run(
        ROUTER,
        componentPayload("config.reminders-off:3"),
        dependencies,
      );

      expect(edits[0]?.content).toContain("Reminders are off");
      expect(edits[0]?.content.length).toBeLessThanOrEqual(2000);
    });

    it("still draws the panel when Discord can't be read at all", async () => {
      const { dependencies, edits } = world(
        {},
        { channels: "fail", roles: "fail" },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<#${FORUM}>`);
      expect(edits[0]?.content).toContain(
        "Could not read this server's channels",
      );
      expect(JSON.stringify(edits)).not.toContain("canary");
    });

    it.each(["@everyone", "<@&123>", "[click](https://evil.example)", "‮evil"])(
      "shows the channel name %j only as a harmless select label",
      async (name) => {
        const { dependencies, edits } = world(
          {},
          { channels: [forum(FORUM, { name })] },
        );

        await run(ROUTER, commandPayload("config"), dependencies);

        const label = componentsOf(edits[0]).at(-1)?.options?.[0]?.label ?? "";
        expect(label).not.toMatch(/[@<>[\]:/.‮]/);
        expect(edits[0]?.content).not.toContain("evil");
      },
    );

    it("falls back to the ID for a name with nothing usable", async () => {
      const { dependencies, edits } = world(
        {},
        { channels: [forum(FORUM, { name: "​@:" })] },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(componentsOf(edits[0]).at(-1)?.options?.[0]?.label).toBe(
        `Forum ${FORUM}`,
      );
    });

    it("stays within Discord's limits with hundreds of forums", async () => {
      const channels = Array.from({ length: 300 }, () =>
        managedRow(testSnowflake()),
      );
      const { dependencies, edits } = world({ channels }, { channels: [] });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain("And 285 more.");
      expect(edits[0]?.content.length).toBeLessThanOrEqual(2000);
      expect(componentsOf(edits[0]).at(-1)?.options).toHaveLength(25);
    });
  });

  describe("the last changes", () => {
    it("names the actor by mention, without pinging", async () => {
      const actor = testSnowflake();
      const { dependencies, edits } = world({
        changes: [change({ actor_id: actor })],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<@${actor}>: added <#${FORUM}>`);
      expect(edits[0]?.content).toContain("2030\\-01\\-02");
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
      });
    });

    it.each([
      [
        "role bindings",
        { action: "role_bindings", old_values: null },
        "changed the roles",
      ],
      [
        "a removal",
        {
          old_values: { active_channel_ids: [FORUM] },
          new_values: { active_channel_ids: [] },
        },
        `removed <#${FORUM}>`,
      ],
      [
        "the removal of a forum that was not active, from the recorded lists",
        {
          old_values: { reminders_enabled: true, active_channel_ids: [] },
          new_values: {
            reminders_enabled: true,
            active_channel_ids: [],
            added_channel_ids: [],
            removed_channel_ids: [FORUM],
          },
        },
        `removed <#${FORUM}>`,
      ],
      [
        "many forums, without listing them all",
        {
          new_values: {
            added_channel_ids: [FORUM, NEW_FORUM, FORUM, NEW_FORUM, FORUM],
          },
        },
        `added <#${FORUM}>, <#${NEW_FORUM}>, <#${FORUM}> and 2 more`,
      ],
      [
        "reminders off",
        {
          old_values: { reminders_enabled: true },
          new_values: { reminders_enabled: false },
        },
        "turned reminders off",
      ],
      [
        "reminders on",
        {
          old_values: { reminders_enabled: false },
          new_values: { reminders_enabled: true },
        },
        "turned reminders on",
      ],
      [
        "no visible difference",
        {
          old_values: { reminders_enabled: true, active_channel_ids: [] },
          new_values: { reminders_enabled: true, active_channel_ids: [] },
        },
        "changed settings",
      ],
    ])("describes %s", async (_label, fields, text) => {
      const { dependencies, edits } = world({ changes: [change(fields)] });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(text);
    });

    it("renders no text from stored values", async () => {
      const { dependencies, edits } = world({
        changes: [
          change({
            old_values: { active_channel_ids: ["canary", 1] },
            new_values: {
              active_channel_ids: ["<@&canary>"],
              added_channel_ids: ["<@&canary>"],
              removed_channel_ids: "canary",
              reminders_enabled: true,
              canary: "canary",
            },
          }),
        ],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).not.toContain("canary");
    });
  });

  it("says only try again when the database fails", async () => {
    const { dependencies, edits, state } = world();
    state.failing = { path: "managed_channels", status: 503 };

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("Something went wrong");
    expect(JSON.stringify(edits)).not.toContain("canary");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
  });

  it("shows no nickname, whatever the payload holds", async () => {
    const { dependencies, edits } = world({ changes: [change()] });

    await run(
      ROUTER,
      commandPayload("config", {
        member: {
          ...ADMINISTRATOR,
          nick: "canary-nick",
          user: {
            id: MEMBER_ID,
            username: "canary-nick",
            global_name: "canary-nick",
          },
        },
      }),
      dependencies,
    );

    expect(JSON.stringify(edits)).not.toContain("canary");
  });

  it("does not claim the interaction just to open the panel", async () => {
    const { dependencies, rpcBodies } = world();

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(rpcBodies("claim_interaction")).toEqual([]);
  });

  it("labels the removal select with each forum's own name", async () => {
    const { dependencies, edits } = world(
      {},
      {
        channels: [
          forum(NEW_FORUM, { name: "other" }),
          forum(FORUM, { name: "events" }),
        ],
      },
    );

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(componentsOf(edits[0]).at(-1)?.options).toEqual([
      { label: "events", value: FORUM },
    ]);
  });

  it("still draws the panel if an audit row has no old values", async () => {
    const { dependencies, edits } = world({
      changes: [change({ old_values: null })],
    });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain(`added <#${FORUM}>`);
  });

  it.each<[string, () => Record<string, unknown>]>([
    ["reminders on", () => componentPayload("config.reminders-on:3")],
    ["reminders off", () => componentPayload("config.reminders-off:3")],
    ["add", () => addPayload(NEW_FORUM)],
    ["remove", () => componentPayload(`config.remove-yes:3:${FORUM}`)],
  ])("gives a replayed %s no second write", async (_label, click) => {
    const { dependencies, edits, rpcBodies } = world();
    const payload = click();

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(rpcBodies("claim_interaction")).toHaveLength(2);
    expect(rpcBodies("apply_config_change")).toHaveLength(1);
    expect(edits).toHaveLength(1);
  });

  it("gives a replayed click no second write", async () => {
    const { dependencies, edits, rpcBodies } = world();
    const payload = componentPayload("config.reminders-off:3");

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(rpcBodies("apply_config_change")).toHaveLength(1);
    expect(edits).toHaveLength(1);
  });
});

describe("every button and select on the panel", () => {
  const CLICKS: [string, () => Record<string, unknown>][] = [
    ["Refresh", () => componentPayload("config.view")],
    ["Reminders on", () => componentPayload("config.reminders-on:3")],
    ["Reminders off", () => componentPayload("config.reminders-off:3")],
    ["Add", () => addPayload(NEW_FORUM)],
    ["Remove", () => removePayload(FORUM)],
    ["Remove it", () => componentPayload(`config.remove-yes:3:${FORUM}`)],
  ];

  it("has a route, for each custom_id a panel can show", async () => {
    const { dependencies, edits } = world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, commandPayload("config"), dependencies);
    await run(ROUTER, removePayload(FORUM), dependencies);
    await run(ROUTER, componentPayload("config.reminders-on:3"), dependencies);

    const prefixes = new Set(
      edits.flatMap(customIds).map((id) => id.split(":")[0]),
    );
    const routed = new Set(
      ROUTER.routes
        .filter((route) => route.surface === "component")
        .map((route) => route.key),
    );
    expect(prefixes.size).toBeGreaterThanOrEqual(5);
    for (const prefix of prefixes) {
      expect(routed.has(prefix ?? "")).toBe(true);
    }
  });

  it.each(CLICKS)(
    "%s refuses a non-admin holding a copied panel",
    async (_label, click) => {
      const { dependencies, edits, rpcBodies } = world();

      const { reply } = await run(
        ROUTER,
        { ...click(), member: PLAIN_MEMBER },
        dependencies,
      );

      expect(reply.data?.content).toBe(REFUSED.message);
      expect(reply.data?.flags).toBe(
        MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
      );
      expect(edits).toEqual([]);
      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(rpcBodies("claim_interaction")).toEqual([]);
    },
  );

  it.each(CLICKS)(
    "%s refuses an admin whose role was removed since it opened",
    async (_label, click) => {
      const { dependencies, edits, rpcBodies } = world();

      await run(
        ROUTER,
        commandPayload("config", { member: ADMIN }),
        dependencies,
      );
      expect(edits).toHaveLength(1);

      const { reply } = await run(
        ROUTER,
        { ...click(), member: member({ roles: [] }) },
        dependencies,
      );

      expect(reply.data?.content).toBe(REFUSED.message);
      expect(edits).toHaveLength(1);
      expect(rpcBodies("apply_config_change")).toEqual([]);
    },
  );

  it.each(CLICKS)("%s refuses an officer", async (_label, click) => {
    const { dependencies } = world();

    const { reply } = await run(
      ROUTER,
      { ...click(), member: OFFICER },
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
  });

  it.each(CLICKS)(
    "%s is refused on a public message",
    async (_label, click) => {
      const { dependencies, rpcBodies } = world();

      const { reply } = await run(
        ROUTER,
        { ...click(), message: { flags: 0 } },
        dependencies,
      );

      expect(reply.data?.content).toBe(REFUSED.message);
      expect(rpcBodies("apply_config_change")).toEqual([]);
    },
  );

  it.each(CLICKS)(
    "%s writes as the signed actor only",
    async (_label, click) => {
      const { dependencies, rpcBodies } = world();

      await run(
        ROUTER,
        { ...click(), member: ADMINISTRATOR, p_actor_id: testSnowflake() },
        dependencies,
      );

      for (const body of rpcBodies("apply_config_change")) {
        expect(body.p_guild_id).toBe(GUILD_ID);
        expect(body.p_actor_id).toBe(MEMBER_ID);
      }
    },
  );
});

describe("reminders", () => {
  it("says while they are off that turning them on waits for the next day's run", async () => {
    const { dependencies, edits } = world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("Reminders: **off**");
    expect(edits[0]?.content).toContain("does not reopen it");
    expect(edits[0]?.content).toContain("the next day's run");
  });

  it("does not mention the run while they are on", async () => {
    const { dependencies, edits } = world();

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).not.toContain("does not reopen it");
  });

  it("says when turning them on takes effect", async () => {
    const { dependencies, edits } = world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, componentPayload("config.reminders-on:3"), dependencies);

    expect(edits[0]?.content).toContain(
      "If the day's run (around 14:00 UTC) has already happened, they resume with the next day's run.",
    );
  });

  it.each([
    ["config.reminders-off:3", false, "Reminders are off"],
    ["config.reminders-on:3", true, "Reminders are on"],
  ])(
    "%s sets it through the versioned function",
    async (customId, value, text) => {
      const { dependencies, edits, rpcBodies, state } = world();

      await run(ROUTER, componentPayload(customId), dependencies);

      expect(rpcBodies("apply_config_change")).toEqual([
        {
          p_guild_id: GUILD_ID,
          p_expected_version: 3,
          p_actor_id: MEMBER_ID,
          p_reminders_enabled: value,
          p_add_channel_ids: [],
          p_remove_channel_ids: [],
          p_timezone: null,
        },
      ]);
      expect(state.config?.reminders_enabled).toBe(value);
      expect(edits[0]?.content).toContain(text);
      expect(customIds(edits[0])).toContain("config.add:4");
    },
  );

  it("refuses a stale version and redraws with the current one", async () => {
    const { dependencies, edits, state } = world({
      config: configRow({ version: 5 }),
    });

    await run(ROUTER, componentPayload("config.reminders-off:3"), dependencies);

    expect(state.config?.reminders_enabled).toBe(true);
    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.reminders-off:5");
  });

  it("lets one of two racing clicks win", async () => {
    const { dependencies, edits, state } = world();

    await Promise.all([
      run(ROUTER, componentPayload("config.reminders-off:3"), dependencies),
      run(ROUTER, componentPayload("config.reminders-off:3"), dependencies),
    ]);

    expect(state.config?.version).toBe(4);
    expect(
      edits.filter((edit) => edit.content.includes("nothing was saved")),
    ).toHaveLength(1);
  });
});

describe("adding a forum", () => {
  it("adds it, with the guild and actor from the payload and the version from the custom_id", async () => {
    const { dependencies, edits, rpcBodies, state } = world();

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(rpcBodies("apply_config_change")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 3,
        p_actor_id: MEMBER_ID,
        p_reminders_enabled: null,
        p_add_channel_ids: [NEW_FORUM],
        p_remove_channel_ids: [],
        p_timezone: null,
      },
    ]);
    expect(state.channels.map((row) => row.channel_id)).toContain(NEW_FORUM);
    expect(edits[0]?.content).toContain(`Added <#${NEW_FORUM}>.`);
  });

  it("answers already managed for an active forum, without writing", async () => {
    const { dependencies, edits, rpcBodies } = world();

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(rpcBodies("apply_config_change")).toEqual([]);
    expect(edits[0]?.content).toContain(`<#${FORUM}> is already managed`);
    expect(customIds(edits[0])).toContain("config.add:3");
  });

  it.each(["removed", "unavailable"] as const)(
    "adds back a forum that is %s",
    async (status) => {
      const { dependencies, rpcBodies } = world({
        channels: [managedRow(FORUM, status)],
      });

      await run(ROUTER, addPayload(FORUM), dependencies);

      expect(rpcBodies("apply_config_change")).toHaveLength(1);
    },
  );

  it("warns right away if @everyone can view the forum it added", async () => {
    const { dependencies, edits } = world(
      {},
      {
        channels: [
          forum(FORUM),
          forum(NEW_FORUM, {
            overwrites: [
              { id: BOT_ROLE, type: 0, allow: ALL_NEEDED, deny: 0n },
            ],
          }),
        ],
      },
    );

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(edits[0]?.content).toContain(
      `<#${NEW_FORUM}>: \\@everyone can view this forum`,
    );
  });

  const refused: [string, () => Record<string, unknown>, string][] = [
    [
      "a text channel in resolved",
      () => addPayload(TEXT_CHANNEL, {}, 3, { id: TEXT_CHANNEL, type: 0 }),
      "not a forum",
    ],
    [
      "a channel from another guild",
      () =>
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          guild_id: testSnowflake(),
        }),
      "not a forum",
    ],
    [
      "a forum Discord does not list in this guild",
      () => addPayload(testSnowflake()),
      "not a forum",
    ],
    [
      "a channel Discord lists as another type",
      () => addPayload(TEXT_CHANNEL),
      "not a forum",
    ],
    [
      "no resolved data",
      () =>
        componentPayload(
          "config.add:3",
          {},
          { component_type: 8, values: [NEW_FORUM] },
        ),
      "not a forum",
    ],
    [
      "resolved data with an inherited name",
      () =>
        componentPayload(
          "config.add:3",
          {},
          {
            component_type: 8,
            values: ["__proto__"],
            resolved: { channels: {} },
          },
        ),
      "not a forum",
    ],
    [
      "two channels at once",
      () =>
        componentPayload(
          "config.add:3",
          {},
          {
            component_type: 8,
            values: [NEW_FORUM, FORUM],
            resolved: {
              channels: {
                [NEW_FORUM]: { id: NEW_FORUM, type: 15 },
                [FORUM]: { id: FORUM, type: 15 },
              },
            },
          },
        ),
      "not a forum",
    ],
    [
      "no values",
      () =>
        componentPayload("config.add:3", {}, { component_type: 8, values: [] }),
      "not a forum",
    ],
    [
      "a button claiming this custom_id",
      () =>
        componentPayload(
          "config.add:3",
          {},
          {
            component_type: 2,
            values: [NEW_FORUM],
            resolved: {
              channels: { [NEW_FORUM]: { id: NEW_FORUM, type: 15 } },
            },
          },
        ),
      "not a forum",
    ],
    [
      "resolved app_permissions empty, which BigInt would read as zero",
      () =>
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          app_permissions: "",
        }),
      "not a forum",
    ],
    [
      "resolved app_permissions as a number",
      () =>
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          app_permissions: 1024,
        }),
      "not a forum",
    ],
    [
      "resolved app_permissions in hex",
      () =>
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          app_permissions: "0x400",
        }),
      "not a forum",
    ],
  ];

  it.each(refused)(
    "refuses %s, with no write",
    async (_label, payload, text) => {
      const { dependencies, edits, rpcBodies } = world();

      await run(ROUTER, payload(), dependencies);

      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(edits[0]?.content).toContain(text);
      expect(customIds(edits[0])).toContain("config.add:3");
    },
  );

  it("refuses when Discord can't list channels and resolved names no guild", async () => {
    const { dependencies, edits, rpcBodies } = world({}, { channels: "fail" });

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(rpcBodies("apply_config_change")).toEqual([]);
    expect(edits[0]?.content).toContain("would not confirm");
  });

  describe("the bot's permissions", () => {
    it("names each one missing in the forum, from its overwrites", async () => {
      const { dependencies, edits, rpcBodies } = world(
        {},
        {
          channels: [
            forum(NEW_FORUM, {
              overwrites: [
                { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
                { id: BOT_ROLE, type: 0, allow: VIEW, deny: 0n },
              ],
            }),
          ],
        },
      );

      await run(ROUTER, addPayload(NEW_FORUM), dependencies);

      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(edits[0]?.content).toContain(
        "missing these permissions in that forum: Send Messages, Send Messages in Threads.",
      );
    });

    it("counts a grant on the bot's own member overwrite", async () => {
      const { dependencies, rpcBodies } = world(
        {},
        {
          channels: [
            forum(NEW_FORUM, {
              overwrites: [
                { id: GUILD_ID, type: 0, allow: 0n, deny: VIEW },
                { id: APP_ID, type: 1, allow: ALL_NEEDED, deny: 0n },
              ],
            }),
          ],
          botRoleIds: [],
        },
      );

      await run(ROUTER, addPayload(NEW_FORUM), dependencies);

      expect(rpcBodies("apply_config_change")).toHaveLength(1);
    });

    it("ignores the top-level app_permissions, which describe the panel's channel", async () => {
      const refused = world({}, { roles: "fail" });
      const allowed = world();

      await run(
        ROUTER,
        addPayload(NEW_FORUM, { app_permissions: String(ALL_NEEDED) }),
        refused.dependencies,
      );
      await run(
        ROUTER,
        addPayload(NEW_FORUM, { app_permissions: "0" }),
        allowed.dependencies,
      );

      expect(refused.rpcBodies("apply_config_change")).toEqual([]);
      expect(refused.edits[0]?.content).toContain("would not confirm");
      expect(allowed.rpcBodies("apply_config_change")).toHaveLength(1);
    });

    const resolvedWith = (permissions: bigint, guild?: string) => ({
      id: NEW_FORUM,
      type: 15,
      app_permissions: String(permissions),
      ...(guild === undefined ? {} : { guild_id: guild }),
    });

    it("reads the forum's own app_permissions before the overwrites", async () => {
      const { dependencies, rpcBodies } = world(
        {},
        {
          channels: [
            forum(NEW_FORUM, {
              overwrites: [{ id: GUILD_ID, type: 0, allow: 0n, deny: VIEW }],
            }),
          ],
          botRoleIds: [],
        },
      );

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(ALL_NEEDED)),
        dependencies,
      );

      expect(rpcBodies("apply_config_change")).toHaveLength(1);
    });

    it("names what the forum's own app_permissions lack, even if overwrites allow it", async () => {
      const { dependencies, edits, rpcBodies } = world();

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(VIEW)),
        dependencies,
      );

      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(edits[0]?.content).toContain(
        ": Send Messages, Send Messages in Threads.",
      );
    });

    it("works from resolved alone if the guild is there and Discord can't be read", async () => {
      const { dependencies, rpcBodies } = world(
        {},
        { channels: "fail", roles: "fail", botRoleIds: "fail" },
      );

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(ALL_NEEDED, GUILD_ID)),
        dependencies,
      );

      expect(rpcBodies("apply_config_change")).toHaveLength(1);
    });

    it("does not round high bits in app_permissions into a permission", async () => {
      const { dependencies, edits, rpcBodies } = world();

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith((1n << 54n) | (1n << 53n))),
        dependencies,
      );

      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(edits[0]?.content).toContain("View Channel");
    });

    it.each([
      ["the role list", { roles: "fail" }],
      ["the bot's member record", { botRoleIds: "fail" }],
    ] as const)(
      "cannot check, and writes nothing, if %s can't be read",
      async (_label, data) => {
        const { dependencies, edits, rpcBodies } = world({}, data);

        await run(ROUTER, addPayload(NEW_FORUM), dependencies);

        expect(rpcBodies("apply_config_change")).toEqual([]);
        expect(edits[0]?.content).toContain("would not confirm");
      },
    );

    it("cannot check if only the guild is known", async () => {
      const { dependencies, edits, rpcBodies } = world(
        {},
        { channels: "fail" },
      );

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          guild_id: GUILD_ID,
        }),
        dependencies,
      );

      expect(rpcBodies("apply_config_change")).toEqual([]);
      expect(edits[0]?.content).toContain("would not confirm");
    });
  });

  it("refuses a stale version and redraws", async () => {
    const { dependencies, edits, state } = world({
      config: configRow({ version: 5 }),
    });

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(state.channels.map((row) => row.channel_id)).not.toContain(
      NEW_FORUM,
    );
    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.add:5");
  });

  it("says it may have saved when the write fails for another reason", async () => {
    const { dependencies, edits, state } = world();
    state.failing = { path: "apply_config_change", status: 503 };

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(edits[0]?.content).toContain("may or may not have been saved");
    expect(JSON.stringify(edits)).not.toContain("canary");
  });
});

describe("removing a forum", () => {
  it("warns with the open-task count and writes nothing on the first click", async () => {
    const { dependencies, edits, rpcBodies, state } = world({
      openTasks: new Map([[FORUM, 7]]),
    });

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("7 open task(s)");
    expect(edits[0]?.content).toContain("stop posting");
    expect(rpcBodies("apply_config_change")).toEqual([]);
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(state.channels[0]?.status).toBe("active");
    expect(customIds(edits[0])).toEqual([
      `config.remove-yes:3:${FORUM}`,
      "config.view",
    ]);
  });

  it("says when there are more tasks than it counted", async () => {
    const { dependencies, edits } = world({
      openTasks: new Map([[FORUM, 500]]),
    });

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("over 100 open task(s)");
  });

  it("removes it on the second click", async () => {
    const { dependencies, edits, rpcBodies, state } = world();

    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect(rpcBodies("apply_config_change")).toEqual([
      {
        p_guild_id: GUILD_ID,
        p_expected_version: 3,
        p_actor_id: MEMBER_ID,
        p_reminders_enabled: null,
        p_add_channel_ids: [],
        p_remove_channel_ids: [FORUM],
        p_timezone: null,
      },
    ]);
    expect(state.channels[0]?.status).toBe("removed");
    expect(edits[0]?.content).toContain(`Removed <#${FORUM}>.`);
    expect(edits[0]?.content).toContain("adding it again resumes");
  });

  it("can remove a forum Discord has deleted", async () => {
    const { dependencies, state } = world({}, { channels: [] });

    await run(ROUTER, removePayload(FORUM), dependencies);
    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect(state.channels[0]?.status).toBe("removed");
  });

  it("redraws, writing nothing, if the first click was on a stale panel", async () => {
    const { dependencies, edits } = world({
      config: configRow({ version: 5 }),
    });

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.add:5");
  });

  it("refuses a stale second click and redraws", async () => {
    const { dependencies, edits, state } = world({
      config: configRow({ version: 5 }),
    });

    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect(state.channels[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain("nothing was saved");
  });

  it("says so if another click already removed it", async () => {
    const { dependencies, edits } = world({
      channels: [managedRow(FORUM, "removed")],
    });

    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect(edits[0]?.content).toContain("no longer possible");
    expect(JSON.stringify(edits)).not.toContain("row text");
  });

  it.each([
    ["a channel the guild does not manage", () => testSnowflake()],
    ["a forum already removed", () => TEXT_CHANNEL],
  ])("refuses %s on the first click", async (_label, channel) => {
    const { dependencies, edits, requests } = world({
      channels: [managedRow(FORUM), managedRow(TEXT_CHANNEL, "removed")],
    });

    await run(ROUTER, removePayload(channel()), dependencies);

    expect(edits[0]?.content).toContain("not managed");
    expect(requests.some((request) => request.target.includes("/tasks"))).toBe(
      false,
    );
  });

  it.each(["__proto__", "x", "", "1,2", 7])(
    "refuses the select value %j",
    async (value) => {
      const { dependencies, edits, requests } = world();

      await run(ROUTER, removePayload(value), dependencies);

      expect(edits[0]?.content).toContain("not a forum");
      expect(
        requests.some((request) => request.target.includes("/tasks")),
      ).toBe(false);
    },
  );

  it("refuses a select with two values, or a button claiming to be the select", async () => {
    const { dependencies, edits } = world();

    await run(
      ROUTER,
      componentPayload(
        "config.remove:3",
        {},
        { component_type: 3, values: [FORUM, FORUM] },
      ),
      dependencies,
    );
    await run(
      ROUTER,
      componentPayload(
        "config.remove:3",
        {},
        { component_type: 2, values: [FORUM] },
      ),
      dependencies,
    );

    expect(edits[0]?.content).toContain("not a forum");
    expect(edits[1]?.content).toContain("not a forum");
  });
});

describe("Refresh", () => {
  it("redraws for an admin, with no claim and no write", async () => {
    const { dependencies, edits, rpcBodies } = world();

    await run(ROUTER, componentPayload("config.view"), dependencies);

    expect(edits[0]?.content).toContain("Bot settings");
    expect(rpcBodies("claim_interaction")).toEqual([]);
    expect(rpcBodies("apply_config_change")).toEqual([]);
  });

  it("is refused once the config has gone", async () => {
    const { dependencies, state } = world();
    state.config = null;

    const { reply } = await run(
      ROUTER,
      componentPayload("config.view"),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
  });
});

describe("adding a forum back", () => {
  const THREAD = testSnowflake();
  const eventRow = (index: number, fields: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    guild_id: GUILD_ID,
    channel_id: FORUM,
    name: "General meeting",
    event_date: "2030-01-15",
    thread_id: THREAD,
    overview_message_id: testSnowflake(),
    status: "closed",
    thread_status: "active",
    created_by: testSnowflake(),
    deleted_at: null,
    created_at: "2030-01-01T00:00:00.000Z",
    ...fields,
  });

  function removedForum(
    events: Record<string, unknown>[],
    editMessage: DiscordClient["editMessage"] = (_target, id) =>
      Promise.resolve({ id }),
  ) {
    const database = fakeDb({
      config: configRow(),
      channels: [managedRow(FORUM, "removed")],
      events,
    });
    const { discord, edits } = fakeDiscord({
      roles: ROLES,
      channels: CHANNELS,
      botRoleIds: [BOT_ROLE],
    });
    const edit = vi.fn(editMessage);
    return {
      ...database,
      edits,
      edit,
      dependencies: dependenciesFor(database.db, {
        ...discord,
        editMessage: edit,
      }),
    };
  }

  it("redraws a closed event's post and says so", async () => {
    const { dependencies, edits, edit, state } = removedForum([eventRow(1)]);

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(state.channels[0]?.status).toBe("active");
    expect(edit).toHaveBeenCalledTimes(1);
    const body = edit.mock.calls[0]?.[2].toJSON() as { content: string };
    expect(body.content).toContain("Status: Closed");
    expect(edits[0]?.content).toContain(
      `Added <#${FORUM}>. Its 1 event post(s) are up to date.`,
    );
  });

  it("adds no line when the forum has no posts", async () => {
    const { dependencies, edits, edit } = removedForum([]);

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(edits[0]?.content).toContain(`Added <#${FORUM}>.\n`);
  });

  it("touches no event for a forum added for the first time", async () => {
    const { dependencies, edit, requests } = removedForum([eventRow(1)]);

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(requests.some(({ target }) => target.includes("/events"))).toBe(
      false,
    );
  });

  it("redraws at most ten posts and says the rest were not checked", async () => {
    const { dependencies, edits, edit } = removedForum(
      Array.from({ length: 12 }, (_, index) => eventRow(index + 1)),
    );

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).toHaveBeenCalledTimes(10);
    expect(edits[0]?.content).toContain(
      "Updated 10 of its event posts. Older posts were not checked.",
    );
  });

  it("stops starting redraws when out of time", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { dependencies, edits, edit } = removedForum(
      Array.from({ length: 5 }, (_, index) => eventRow(index + 1)),
      (_target, id) => {
        now += 25_000;
        return Promise.resolve({ id });
      },
    );

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).toHaveBeenCalledTimes(1);
    expect(edits[0]?.content).toContain(
      "Updated 1 of its event posts. 4 could not be updated.",
    );
  });

  it("keeps the forum and goes on when a post can't be redrawn", async () => {
    const { dependencies, edits, edit, state } = removedForum(
      [eventRow(1), eventRow(2)],
      () => Promise.reject(new Error("canary discord failure")),
    );

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).toHaveBeenCalledTimes(2);
    expect(state.channels[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain(
      "Updated 0 of its event posts. 2 could not be updated.",
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
  });

  it("keeps the forum and says so when the events can't be read", async () => {
    const { dependencies, edits, edit, state } = removedForum([eventRow(1)]);
    state.failing = { path: "/events", status: 503 };

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(state.channels[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain("Its event posts could not be checked");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("canary");
  });

  it("redraws nothing when the write is refused as stale", async () => {
    const { dependencies, edits, edit } = removedForum([eventRow(1)]);

    await run(ROUTER, addPayload(FORUM, {}, 2), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(edits[0]?.content).toContain("nothing was saved");
  });
});
