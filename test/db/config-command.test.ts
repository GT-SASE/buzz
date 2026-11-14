import {
  InteractionResponseType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
  spyOn,
} from "bun:test";
import {
  ADMIN,
  ADMINISTRATOR,
  commandPayload,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDiscord,
  GUILD_ID,
  managedRow,
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
import { ROUTER } from "../../src/handlers/registry.ts";
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

beforeEach(() => {
  spyOn(console, "error").mockImplementation(() => undefined);
});

describe("/config", () => {
  it("defers privately and draws the panel for the bound admin role", async () => {
    const { dependencies, edits } = await world();

    const { reply } = await run(
      ROUTER,
      commandPayload("config", { member: ADMIN }),
      dependencies,
    );

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

  it.each<[string, Record<string, unknown>, Seed]>([
    ["a member", PLAIN_MEMBER, {}],
    ["an officer", OFFICER, {}],
    ["an administrator before setup", ADMINISTRATOR, { config: null }],
  ])("refuses %s with the fixed reply", async (_label, who, seed) => {
    const { dependencies, edits } = await world(seed);

    const { reply, deferred } = await run(
      ROUTER,
      commandPayload("config", { member: who }),
      dependencies,
    );

    expect(reply.data?.content).toBe(REFUSED.message);
    expect(deferred).toBe(false);
    expect(edits).toEqual([]);
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

    it("keeps working when a managed forum was deleted, and offers its removal", async () => {
      const { dependencies, edits } = await world({}, { channels: [] });

      await run(ROUTER, commandPayload("config"), dependencies);

      expect(edits[0]?.content).toContain(`<#${FORUM}>: deleted from Discord`);
      const remove = componentsOf(edits[0]).at(-1);
      expect(remove?.options).toEqual([
        { label: `Forum ${FORUM}`, value: FORUM },
      ]);
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

    it.each(["@everyone <@&123> [click](https://evil.example) ‮evil"])(
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

    it.each([["treasury_role_id", "Treasury Committee"]] as const)(
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
        "a separate admin role replaced by E-board",
        {
          action: "role_bindings",
          old_values: { ...BOUND, admin_role_id: FORUM },
          new_values: BOUND,
        },
        "changed the Admin role",
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

  it.each<[string, () => Record<string, unknown>]>([
    ["reminders off", () => componentPayload("config.reminders-off:3")],
    ["add", () => addPayload(NEW_FORUM)],
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

  it.each(CLICKS)(
    "%s refuses a non-admin holding a copied panel, and an admin on a public message",
    async (_label, click) => {
      const w = await world();
      const { dependencies, edits } = w;

      const copied = await run(
        ROUTER,
        { ...click(), member: PLAIN_MEMBER },
        dependencies,
      );
      const onPublic = await run(
        ROUTER,
        { ...click(), message: { flags: 0 } },
        dependencies,
      );

      for (const { reply } of [copied, onPublic]) {
        expect(reply.data?.content).toBe(REFUSED.message);
        expect(reply.data?.flags).toBe(
          MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
        );
      }
      expect(edits).toEqual([]);
      expect(await saves(w)).toBe(0);
      expect(await w.claims()).toBe(0);
    },
  );
});

describe("reminders", () => {
  // The day's run, as a timestamp each reader sees in their own zone.
  const NOW = Date.UTC(2026, 10, 3, 12);
  const RUN_AT = `<t:${String(Date.UTC(2026, 10, 3, SLOT_START_HOUR_UTC) / 1000)}:t>`;
  beforeEach(() => {
    setSystemTime(NOW);
  });
  afterEach(() => {
    setSystemTime();
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

  const refused: [string, () => Record<string, unknown>, string][] = [
    [
      "a text channel in resolved",
      () => addPayload(TEXT_CHANNEL, {}, 3, { id: TEXT_CHANNEL, type: 0 }),
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

    it.each([
      ["the channel list", { channels: "fail" }],
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
    const edit = mock(editMessage);
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
});
