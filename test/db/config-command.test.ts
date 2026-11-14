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
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import type {
  DiscordClient,
  GuildChannel,
  GuildRole,
} from "../../src/discord/client.ts";
import { REFUSED } from "../../src/lib/permissions.ts";
import { SLOT_START_HOUR_UTC } from "../../src/reminders/plan.ts";
import { COMMANDS, ROUTER } from "../../src/handlers/registry.ts";
import { handlerDb, type HandlerDb, type Seed } from "./handler-db.ts";

const VIEW = PermissionFlagsBits.ViewChannel;
const SEND = PermissionFlagsBits.SendMessages;
const SEND_IN_THREADS = PermissionFlagsBits.SendMessagesInThreads;
const ALL_NEEDED = VIEW | SEND | SEND_IN_THREADS;

const FORUM = fakeId();
const NEW_FORUM = fakeId();
const TEXT_CHANNEL = fakeId();
const BOT_ROLE = fakeId();

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

async function world(fields: Seed = {}, discordData: FakeDiscordData = {}) {
  const database = await handlerDb({
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

/** How many settings changes were saved, from the audit trail. */
async function saves(database: HandlerDb): Promise<number> {
  const changes = await database.changes();
  return changes.filter((change) => change.action === "settings").length;
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

const EBOARD = fakeId();

/** All five roles bound, as /setup saves them, as a config row or an audit row's values. */
const BOUND = {
  officer_role_id: fakeId(),
  admin_role_id: EBOARD,
  eboard_role_id: EBOARD,
  events_committee_role_id: fakeId(),
  treasury_role_id: fakeId(),
  marketing_role_id: fakeId(),
};

function change(fields: Partial<ChangeRow> = {}): ChangeRow {
  return {
    id: 1,
    actor_id: fakeId(),
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
    const { dependencies, edits } = await world();

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
    const { dependencies, edits } = await world();

    await run(ROUTER, commandPayload("config", { member: who }), dependencies);

    expect(edits).toHaveLength(1);
  });

  it.each([
    ["a member", PLAIN_MEMBER],
    ["an officer", OFFICER],
  ])("refuses %s with the fixed reply", async (_label, who) => {
    const { dependencies, edits } = await world();

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
    const { dependencies } = await world({ config: null });

    const { reply } = await run(
      ROUTER,
      commandPayload("config", { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
  });

  it("limits the channel select to forums, with no default values", async () => {
    const { dependencies, edits } = await world();

    await run(ROUTER, commandPayload("config"), dependencies);

    const [select] = componentsOf(edits[0]);
    expect(select?.channel_types).toEqual([15]);
    expect(select?.default_values).toBeUndefined();
  });

  it("shows the switch that does the opposite of the current state", async () => {
    const off = await world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, commandPayload("config"), off.dependencies);

    expect(off.edits[0]?.content).toContain("Reminders: **off**");
    expect(customIds(off.edits[0])).toContain("config.reminders-on:3");
    expect(customIds(off.edits[0])).not.toContain("config.reminders-off:3");
  });

  it("leaves out the removal select when no forum is managed", async () => {
    const { dependencies, edits } = await world({ channels: [] });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("None yet.");
    expect(customIds(edits[0])).toEqual([
      "config.add:3",
      "config.reminders-off:3",
      "config.view",
    ]);
  });

  it("does not list a removed forum", async () => {
    const { dependencies, edits } = await world({
      channels: [managedRow(FORUM, "removed")],
    });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).not.toContain(FORUM);
  });

  describe("what Discord says about a managed forum", () => {
    it("warns when @everyone can view it", async () => {
      const { dependencies, edits } = await world(
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
      const { dependencies, edits } = await world();

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).not.toContain("can view this forum");
    });

    it("does not guess when the roles can't be read", async () => {
      const { dependencies, edits } = await world(
        {},
        { channels: [forum(FORUM, { overwrites: [] })], roles: "fail" },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).not.toContain("can view this forum");
      expect(customIds(edits[0])).toContain("config.remove:3");
    });

    it("keeps working when a managed forum was deleted, and offers its removal", async () => {
      const { dependencies, edits } = await world({}, { channels: [] });

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
        const { dependencies, edits } = await world(
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
      const { dependencies, edits } = await world({
        channels: [managedRow(FORUM, "unavailable")],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain("Add it again to resume");
      expect(edits[0]?.content).not.toContain("lost access");
    });

    it("fits the longest panel in one message", async () => {
      const forums = Array.from({ length: 20 }, () => fakeId());
      const long = (id: string) => id.padEnd(20, "0");
      const { dependencies, edits } = await world(
        {
          config: configRow({ reminders_enabled: true }),
          channels: forums.map((id) => managedRow(long(id), "unavailable")),
          changes: Array.from({ length: 5 }, (_, id) =>
            change({
              // Above the ids the audit table gives out, as these panels save.
              id: 1000 + id,
              actor_id: long(fakeId()),
              new_values: {
                reminders_enabled: true,
                removed_channel_ids: [long(fakeId())],
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

    it("lists fewer forums when the roles and role changes take the room", async () => {
      const forums = Array.from({ length: 20 }, () => fakeId());
      const long = (id: string) => id.padEnd(20, "0");
      const sixRoles = () => ({
        officer_role_id: long(fakeId()),
        admin_role_id: long(fakeId()),
        eboard_role_id: long(fakeId()),
        events_committee_role_id: long(fakeId()),
        treasury_role_id: long(fakeId()),
        marketing_role_id: long(fakeId()),
      });
      const { dependencies, edits } = await world(
        {
          config: configRow({
            officer_role_id: long(fakeId()),
            admin_role_id: long(fakeId()),
          }),
          channels: forums.map((id) => managedRow(long(id), "unavailable")),
          changes: Array.from({ length: 5 }, (_, id) =>
            change({
              // Above the ids the audit table gives out, as these panels save.
              id: 1000 + id,
              actor_id: long(fakeId()),
              action: "role_bindings",
              old_values: sixRoles(),
              new_values: sixRoles(),
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

      const content = edits[0]?.content ?? "";
      expect(content).toContain("Reminders are off");
      expect(content).toContain(
        "Marketing Committee: Run /setup to choose the Marketing Committee role.",
      );
      expect(content).toContain(
        "changed the roles: Admin, E-board, Events Directors, Events Committee, Treasury Committee, Marketing Committee",
      );
      expect(content).toMatch(/And 1[05] more\./);
      expect(content.length).toBeLessThanOrEqual(2000);
      expect(componentsOf(edits[0]).at(-1)?.options).toHaveLength(20);
    });

    it("still draws the panel when Discord can't be read at all", async () => {
      const { dependencies, edits } = await world(
        {},
        { channels: "fail", roles: "fail" },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<#${FORUM}>`);
      expect(edits[0]?.content).toContain(
        "Could not read this server's channels",
      );
    });

    it.each(["@everyone", "<@&123>", "[click](https://evil.example)", "‮evil"])(
      "shows the channel name %j only as a harmless select label",
      async (name) => {
        const { dependencies, edits } = await world(
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
      const { dependencies, edits } = await world(
        {},
        { channels: [forum(FORUM, { name: "​@:" })] },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(componentsOf(edits[0]).at(-1)?.options?.[0]?.label).toBe(
        `Forum ${FORUM}`,
      );
    });

    it("stays within Discord's limits with hundreds of forums", async () => {
      const channels = Array.from({ length: 300 }, () => managedRow(fakeId()));
      const { dependencies, edits } = await world(
        { channels },
        { channels: [] },
      );

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain("And 285 more.");
      expect(edits[0]?.content.length).toBeLessThanOrEqual(2000);
      expect(componentsOf(edits[0]).at(-1)?.options).toHaveLength(25);
    });
  });

  describe("the roles", () => {
    it("shows all five bound roles as mentions that ping nobody, with E-board as admin", async () => {
      const { dependencies, edits } = await world({
        config: configRow({ ...BOUND }),
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      const content = edits[0]?.content ?? "";
      expect(content).not.toContain("Admin:");
      expect(content).toContain(
        [
          "**Roles**",
          `E-board (also admin): <@&${BOUND.eboard_role_id}>`,
          `Events Directors: <@&${BOUND.officer_role_id}>`,
          `Events Committee: <@&${BOUND.events_committee_role_id}>`,
          `Treasury Committee: <@&${BOUND.treasury_role_id}>`,
          `Marketing Committee: <@&${BOUND.marketing_role_id}>`,
        ].join("\n"),
      );
      expect(content).not.toContain("Run /setup");
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
      });
      expect(
        (edits[0] as { allowed_mentions?: { roles?: unknown } })
          .allowed_mentions?.roles ?? [],
      ).toEqual([]);
    });

    it("shows an admin role held apart from E-board on its own line", async () => {
      const admin = fakeId();
      const { dependencies, edits } = await world({
        config: configRow({ ...BOUND, admin_role_id: admin }),
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      const content = edits[0]?.content ?? "";
      expect(content).toContain(
        [
          "**Roles**",
          `Admin: <@&${admin}>`,
          `E-board: <@&${BOUND.eboard_role_id}>`,
          `Events Directors: <@&${BOUND.officer_role_id}>`,
        ].join("\n"),
      );
      expect(content).not.toContain("(also admin)");
    });

    it("shows the admin role apart when E-board is unset", async () => {
      const { dependencies, edits } = await world({
        config: configRow({ ...BOUND, eboard_role_id: null }),
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(
        `Admin: <@&${BOUND.admin_role_id}>\nE-board: Run /setup to choose the E-board role.`,
      );
    });

    it.each([
      ["eboard_role_id", "E-board"],
      ["events_committee_role_id", "Events Committee"],
      ["treasury_role_id", "Treasury Committee"],
      ["marketing_role_id", "Marketing Committee"],
    ] as const)(
      "says to run /setup when %s is unset",
      async (column, label) => {
        const { dependencies, edits } = await world({
          config: configRow({ ...BOUND, [column]: null }),
        });

        await run(ROUTER, commandPayload("config"), dependencies);

        expect(edits[0]?.content).toContain(
          `${label}: Run /setup to choose the ${label} role.`,
        );
        expect(edits[0]?.content.match(/Run \/setup/g)).toHaveLength(1);
      },
    );
  });

  describe("the last changes", () => {
    it("names the actor by mention, without pinging", async () => {
      const actor = fakeId();
      const { dependencies, edits } = await world({
        changes: [change({ actor_id: actor })],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<@${actor}>: added <#${FORUM}>`);
      expect(edits[0]?.content).toContain("2030\\-01\\-02");
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
      });
    });

    it("dates a change by its UTC day, whatever offset its text carries", async () => {
      const { dependencies, edits } = await world({
        changes: [change({ created_at: "2030-01-02T21:00:00-05:00" })],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain("2030\\-01\\-03");
      expect(edits[0]?.content).not.toContain("2030\\-01\\-02");
    });

    it.each([
      [
        "the first role bindings",
        { action: "role_bindings", old_values: null },
        "chose the roles",
      ],
      [
        "one changed role, by the club's name for it",
        {
          action: "role_bindings",
          old_values: { ...BOUND, officer_role_id: FORUM },
          new_values: BOUND,
        },
        "changed the Events Directors role",
      ],
      [
        "several changed roles, including the four added later",
        {
          action: "role_bindings",
          old_values: {
            ...BOUND,
            eboard_role_id: null,
            treasury_role_id: null,
          },
          new_values: BOUND,
        },
        "changed the roles: E-board, Treasury Committee",
      ],
      [
        "E-board changed, with the admin role following it",
        {
          action: "role_bindings",
          old_values: { ...BOUND, eboard_role_id: FORUM, admin_role_id: FORUM },
          new_values: BOUND,
        },
        "changed the E-board role",
      ],
      [
        "a separate admin role replaced by E-board",
        {
          action: "role_bindings",
          old_values: { ...BOUND, admin_role_id: FORUM },
          new_values: BOUND,
        },
        "changed the Admin role",
      ],
      [
        "an older row that only knew two roles",
        {
          action: "role_bindings",
          old_values: { officer_role_id: FORUM, admin_role_id: FORUM },
          new_values: { officer_role_id: NEW_FORUM, admin_role_id: FORUM },
        },
        "changed the Events Directors role",
      ],
      [
        "role bindings saved with no difference",
        { action: "role_bindings", old_values: BOUND, new_values: BOUND },
        "saved the roles unchanged",
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
      const { dependencies, edits } = await world({
        changes: [change(fields)],
      });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(text);
    });

    it("renders no text from stored values", async () => {
      const { dependencies, edits } = await world({
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
    const w = await world();
    const { dependencies, edits } = w;
    w.fail("managed_channels");

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("Something went wrong");
  });

  it("shows no nickname, whatever the payload holds", async () => {
    const { dependencies, edits } = await world({ changes: [change()] });

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
    const w = await world();
    const { dependencies } = w;

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(await w.claims()).toBe(0);
  });

  it("labels the removal select with each forum's own name", async () => {
    const { dependencies, edits } = await world(
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
    const { dependencies, edits } = await world({
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
    const w = await world();
    const { dependencies, edits } = w;
    const payload = click();

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(await w.claims()).toBe(1);
    expect(await saves(w)).toBe(1);
    expect(edits).toHaveLength(1);
  });

  it("gives a replayed click no second write", async () => {
    const w = await world();
    const { dependencies, edits } = w;
    const payload = componentPayload("config.reminders-off:3");

    await run(ROUTER, payload, dependencies);
    await run(ROUTER, payload, dependencies);

    expect(await saves(w)).toBe(1);
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
    const { dependencies, edits } = await world({
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
      const w = await world();
      const { dependencies, edits } = w;

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
      expect(await saves(w)).toBe(0);
      expect(await w.claims()).toBe(0);
    },
  );

  it.each(CLICKS)(
    "%s refuses an admin whose role was removed since it opened",
    async (_label, click) => {
      const w = await world();
      const { dependencies, edits } = w;

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
      expect(await saves(w)).toBe(0);
    },
  );

  it.each(CLICKS)("%s refuses an officer", async (_label, click) => {
    const { dependencies } = await world();

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
      const w = await world();
      const { dependencies } = w;

      const { reply } = await run(
        ROUTER,
        { ...click(), message: { flags: 0 } },
        dependencies,
      );

      expect(reply.data?.content).toBe(REFUSED.message);
      expect(await saves(w)).toBe(0);
    },
  );

  it.each(CLICKS)(
    "%s writes as the signed actor only",
    async (_label, click) => {
      const w = await world();
      const { dependencies } = w;

      await run(
        ROUTER,
        { ...click(), member: ADMINISTRATOR, p_actor_id: fakeId() },
        dependencies,
      );

      for (const change of await w.changes()) {
        expect(change.actor_id).toBe(MEMBER_ID);
      }
    },
  );
});

describe("reminders", () => {
  // The day's run, as a timestamp each reader sees in their own zone.
  const NOW = Date.UTC(2026, 10, 3, 12);
  const RUN_AT = `<t:${String(Date.UTC(2026, 10, 3, SLOT_START_HOUR_UTC) / 1000)}:t>`;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says while they are off that turning them on waits for the next day's run", async () => {
    const { dependencies, edits } = await world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).toContain("Reminders: **off**");
    expect(edits[0]?.content).toContain(
      `Turning them on after the day's run (around ${RUN_AT}) does not reopen it: they resume with the next day's run.`,
    );
  });

  it("does not mention the run while they are on", async () => {
    const { dependencies, edits } = await world();

    await run(ROUTER, commandPayload("config"), dependencies);

    expect(edits[0]?.content).not.toContain("does not reopen it");
  });

  it("says when turning them on takes effect", async () => {
    const { dependencies, edits } = await world({
      config: configRow({ reminders_enabled: false }),
    });

    await run(ROUTER, componentPayload("config.reminders-on:3"), dependencies);

    expect(edits[0]?.content).toContain(
      `If the day's run (around ${RUN_AT}) has already happened, they resume with the next day's run.`,
    );
  });

  it.each([
    ["config.reminders-off:3", false, "Reminders are off"],
    ["config.reminders-on:3", true, "Reminders are on"],
  ])(
    "%s sets it through the versioned function",
    async (customId, value, text) => {
      const w = await world();
      const { dependencies, edits } = w;

      await run(ROUTER, componentPayload(customId), dependencies);

      expect(await w.changes()).toEqual([
        { actor_id: MEMBER_ID, action: "settings" },
      ]);
      expect((await w.config())?.version).toBe(4);
      expect((await w.config())?.reminders_enabled).toBe(value);
      expect(edits[0]?.content).toContain(text);
      expect(customIds(edits[0])).toContain("config.add:4");
    },
  );

  it("refuses a stale version and redraws with the current one", async () => {
    const w = await world({
      config: configRow({ version: 5 }),
    });
    const { dependencies, edits } = w;

    await run(ROUTER, componentPayload("config.reminders-off:3"), dependencies);

    expect((await w.config())?.reminders_enabled).toBe(true);
    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.reminders-off:5");
  });

  it("lets one of two racing clicks win", async () => {
    const w = await world();
    const { dependencies, edits } = w;

    await Promise.all([
      run(ROUTER, componentPayload("config.reminders-off:3"), dependencies),
      run(ROUTER, componentPayload("config.reminders-off:3"), dependencies),
    ]);

    expect((await w.config())?.version).toBe(4);
    expect(
      edits.filter((edit) => edit.content.includes("nothing was saved")),
    ).toHaveLength(1);
  });
});

describe("adding a forum", () => {
  it("adds it, with the guild and actor from the payload and the version from the custom_id", async () => {
    const w = await world();
    const { dependencies, edits } = w;

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(await w.changes()).toEqual([
      { actor_id: MEMBER_ID, action: "settings" },
    ]);
    expect((await w.config())?.version).toBe(4);
    expect((await w.channels()).map((row) => row.channel_id)).toContain(
      NEW_FORUM,
    );
    expect(edits[0]?.content).toContain(`Added <#${NEW_FORUM}>.`);
  });

  it("answers already managed for an active forum, without writing", async () => {
    const w = await world();
    const { dependencies, edits } = w;

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(await saves(w)).toBe(0);
    expect(edits[0]?.content).toContain(`<#${FORUM}> is already managed`);
    expect(customIds(edits[0])).toContain("config.add:3");
  });

  it.each(["removed", "unavailable"] as const)(
    "adds back a forum that is %s",
    async (status) => {
      const w = await world({
        channels: [managedRow(FORUM, status)],
      });
      const { dependencies } = w;

      await run(ROUTER, addPayload(FORUM), dependencies);

      expect(await saves(w)).toBe(1);
    },
  );

  it("warns right away if @everyone can view the forum it added", async () => {
    const { dependencies, edits } = await world(
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
          guild_id: fakeId(),
        }),
      "not a forum",
    ],
    [
      "a forum Discord does not list in this guild",
      () => addPayload(fakeId()),
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
      const w = await world();
      const { dependencies, edits } = w;

      await run(ROUTER, payload(), dependencies);

      expect(await saves(w)).toBe(0);
      expect(edits[0]?.content).toContain(text);
      expect(customIds(edits[0])).toContain("config.add:3");
    },
  );

  it("refuses when Discord can't list channels and resolved names no guild", async () => {
    const w = await world({}, { channels: "fail" });
    const { dependencies, edits } = w;

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(await saves(w)).toBe(0);
    expect(edits[0]?.content).toContain("would not confirm");
  });

  describe("the bot's permissions", () => {
    it("names each one missing in the forum, from its overwrites", async () => {
      const w = await world(
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
      const { dependencies, edits } = w;

      await run(ROUTER, addPayload(NEW_FORUM), dependencies);

      expect(await saves(w)).toBe(0);
      expect(edits[0]?.content).toContain(
        "missing these permissions in that forum: Send Messages, Send Messages in Threads.",
      );
    });

    it("counts a grant on the bot's own member overwrite", async () => {
      const w = await world(
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
      const { dependencies } = w;

      await run(ROUTER, addPayload(NEW_FORUM), dependencies);

      expect(await saves(w)).toBe(1);
    });

    it("ignores the top-level app_permissions, which describe the panel's channel", async () => {
      const refused = await world({}, { roles: "fail" });
      const allowed = await world();

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

      expect(await saves(refused)).toBe(0);
      expect(refused.edits[0]?.content).toContain("would not confirm");
      expect(await saves(allowed)).toBe(1);
    });

    const resolvedWith = (permissions: bigint, guild?: string) => ({
      id: NEW_FORUM,
      type: 15,
      app_permissions: String(permissions),
      ...(guild === undefined ? {} : { guild_id: guild }),
    });

    it("reads the forum's own app_permissions before the overwrites", async () => {
      const w = await world(
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
      const { dependencies } = w;

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(ALL_NEEDED)),
        dependencies,
      );

      expect(await saves(w)).toBe(1);
    });

    it("names what the forum's own app_permissions lack, even if overwrites allow it", async () => {
      const w = await world();
      const { dependencies, edits } = w;

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(VIEW)),
        dependencies,
      );

      expect(await saves(w)).toBe(0);
      expect(edits[0]?.content).toContain(
        ": Send Messages, Send Messages in Threads.",
      );
    });

    it("works from resolved alone if the guild is there and Discord can't be read", async () => {
      const w = await world(
        {},
        { channels: "fail", roles: "fail", botRoleIds: "fail" },
      );
      const { dependencies } = w;

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith(ALL_NEEDED, GUILD_ID)),
        dependencies,
      );

      expect(await saves(w)).toBe(1);
    });

    it("does not round high bits in app_permissions into a permission", async () => {
      const w = await world();
      const { dependencies, edits } = w;

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, resolvedWith((1n << 54n) | (1n << 53n))),
        dependencies,
      );

      expect(await saves(w)).toBe(0);
      expect(edits[0]?.content).toContain("View Channel");
    });

    it.each([
      ["the role list", { roles: "fail" }],
      ["the bot's member record", { botRoleIds: "fail" }],
    ] as const)(
      "cannot check, and writes nothing, if %s can't be read",
      async (_label, data) => {
        const w = await world({}, data);
        const { dependencies, edits } = w;

        await run(ROUTER, addPayload(NEW_FORUM), dependencies);

        expect(await saves(w)).toBe(0);
        expect(edits[0]?.content).toContain("would not confirm");
      },
    );

    it("cannot check if only the guild is known", async () => {
      const w = await world({}, { channels: "fail" });
      const { dependencies, edits } = w;

      await run(
        ROUTER,
        addPayload(NEW_FORUM, {}, 3, {
          id: NEW_FORUM,
          type: 15,
          guild_id: GUILD_ID,
        }),
        dependencies,
      );

      expect(await saves(w)).toBe(0);
      expect(edits[0]?.content).toContain("would not confirm");
    });
  });

  it("refuses a stale version and redraws", async () => {
    const w = await world({
      config: configRow({ version: 5 }),
    });
    const { dependencies, edits } = w;

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect((await w.channels()).map((row) => row.channel_id)).not.toContain(
      NEW_FORUM,
    );
    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.add:5");
  });

  it("says it may have saved when the write fails for another reason", async () => {
    const w = await world();
    const { dependencies, edits } = w;
    w.fail("apply_config_change");

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(edits[0]?.content).toContain("may or may not have been saved");
  });
});

describe("removing a forum", () => {
  it("warns with the open-task count and writes nothing on the first click", async () => {
    const w = await world({
      openTasks: new Map([[FORUM, 7]]),
    });
    const { dependencies, edits } = w;

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("7 open task(s)");
    expect(edits[0]?.content).toContain("stop posting");
    expect(await saves(w)).toBe(0);
    expect(await w.claims()).toBe(0);
    expect((await w.channels())[0]?.status).toBe("active");
    expect(customIds(edits[0])).toEqual([
      `config.remove-yes:3:${FORUM}`,
      "config.view",
    ]);
  });

  it("says when there are more tasks than it counted", async () => {
    const { dependencies, edits } = await world({
      openTasks: new Map([[FORUM, 500]]),
    });

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("over 100 open task(s)");
  });

  it("removes it on the second click", async () => {
    const w = await world();
    const { dependencies, edits } = w;

    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect(await w.changes()).toEqual([
      { actor_id: MEMBER_ID, action: "settings" },
    ]);
    expect((await w.config())?.version).toBe(4);
    expect((await w.channels())[0]?.status).toBe("removed");
    expect(edits[0]?.content).toContain(`Removed <#${FORUM}>.`);
    expect(edits[0]?.content).toContain("adding it again resumes");
  });

  it("can remove a forum Discord has deleted", async () => {
    const w = await world({}, { channels: [] });
    const { dependencies } = w;

    await run(ROUTER, removePayload(FORUM), dependencies);
    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect((await w.channels())[0]?.status).toBe("removed");
  });

  it("redraws, writing nothing, if the first click was on a stale panel", async () => {
    const { dependencies, edits } = await world({
      config: configRow({ version: 5 }),
    });

    await run(ROUTER, removePayload(FORUM), dependencies);

    expect(edits[0]?.content).toContain("nothing was saved");
    expect(customIds(edits[0])).toContain("config.add:5");
  });

  it("refuses a stale second click and redraws", async () => {
    const w = await world({
      config: configRow({ version: 5 }),
    });
    const { dependencies, edits } = w;

    await run(
      ROUTER,
      componentPayload(`config.remove-yes:3:${FORUM}`),
      dependencies,
    );

    expect((await w.channels())[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain("nothing was saved");
  });

  it("says so if another click already removed it", async () => {
    const { dependencies, edits } = await world({
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
    ["a channel the guild does not manage", () => fakeId()],
    ["a forum already removed", () => TEXT_CHANNEL],
  ])("refuses %s on the first click", async (_label, channel) => {
    const w = await world({
      channels: [managedRow(FORUM), managedRow(TEXT_CHANNEL, "removed")],
    });
    const { dependencies, edits } = w;
    // Counting the tasks would fail, so the refusal shows nothing was counted.
    w.fail("tasks");

    await run(ROUTER, removePayload(channel()), dependencies);

    expect(edits[0]?.content).toContain("not managed");
  });

  it.each(["__proto__", "x", "", "1,2", 7])(
    "refuses the select value %j",
    async (value) => {
      const w = await world();
      const { dependencies, edits } = w;
      // Counting the tasks would fail, so the refusal shows nothing was counted.
      w.fail("tasks");

      await run(ROUTER, removePayload(value), dependencies);

      expect(edits[0]?.content).toContain("not a forum");
    },
  );

  it("refuses a select with two values, or a button claiming to be the select", async () => {
    const { dependencies, edits } = await world();

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
    const w = await world();
    const { dependencies, edits } = w;

    await run(ROUTER, componentPayload("config.view"), dependencies);

    expect(edits[0]?.content).toContain("Bot settings");
    expect(await w.claims()).toBe(0);
    expect(await saves(w)).toBe(0);
  });

  it("is refused once the config has gone", async () => {
    const { dependencies } = await world({ config: null });

    const { reply } = await run(
      ROUTER,
      componentPayload("config.view"),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
  });
});

describe("adding a forum back", () => {
  const eventRow = (index: number, fields: Record<string, unknown> = {}) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    guild_id: GUILD_ID,
    channel_id: FORUM,
    name: "General meeting",
    event_date: "2030-01-15",
    thread_id: fakeId(),
    overview_message_id: fakeId(),
    status: "closed",
    thread_status: "active",
    created_by: fakeId(),
    deleted_at: null,
    created_at: "2030-01-01T00:00:00.000Z",
    ...fields,
  });

  async function removedForum(
    events: Record<string, unknown>[],
    editMessage: DiscordClient["editMessage"] = (_target, id) =>
      Promise.resolve({ id }),
  ) {
    const database = await handlerDb({
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
    const w = await removedForum([eventRow(1)]);
    const { dependencies, edits, edit } = w;

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect((await w.channels())[0]?.status).toBe("active");
    expect(edit).toHaveBeenCalledTimes(1);
    const body = edit.mock.calls[0]?.[2].payload as { content: string };
    expect(body.content).toContain("Status: Closed");
    expect(edits[0]?.content).toContain(
      `Added <#${FORUM}>. Its 1 event post(s) are up to date.`,
    );
  });

  it("adds no line when the forum has no posts", async () => {
    const { dependencies, edits, edit } = await removedForum([]);

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(edits[0]?.content).toContain(`Added <#${FORUM}>.\n`);
  });

  it("touches no event for a forum added for the first time", async () => {
    const w = await removedForum([eventRow(1)]);
    const { dependencies, edit, edits } = w;
    // Reading the forum's events would fail, and the reply would say so.
    w.fail("events");

    await run(ROUTER, addPayload(NEW_FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(edits[0]?.content).not.toContain("could not be checked");
  });

  it("redraws at most ten posts and says the rest were not checked", async () => {
    const { dependencies, edits, edit } = await removedForum(
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
    const { dependencies, edits, edit } = await removedForum(
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
    const w = await removedForum([eventRow(1), eventRow(2)], () =>
      Promise.reject(new Error("discord failure")),
    );
    const { dependencies, edits, edit } = w;

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).toHaveBeenCalledTimes(2);
    expect((await w.channels())[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain(
      "Updated 0 of its event posts. 2 could not be updated.",
    );
  });

  it("keeps the forum and says so when the events can't be read", async () => {
    const w = await removedForum([eventRow(1)]);
    const { dependencies, edits, edit } = w;
    w.fail("events");

    await run(ROUTER, addPayload(FORUM), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect((await w.channels())[0]?.status).toBe("active");
    expect(edits[0]?.content).toContain("Its event posts could not be checked");
  });

  it("redraws nothing when the write is refused as stale", async () => {
    const { dependencies, edits, edit } = await removedForum([eventRow(1)]);

    await run(ROUTER, addPayload(FORUM, {}, 2), dependencies);

    expect(edit).not.toHaveBeenCalled();
    expect(edits[0]?.content).toContain("nothing was saved");
  });
});
