import {
  ApplicationCommandOptionType,
  InteractionResponseType,
  MessageFlags,
} from "discord-api-types/v10";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  ADMIN,
  ADMIN_ROLE,
  ADMINISTRATOR,
  ADMINISTRATOR_BIT as ADMINISTRATOR_PERMISSIONS,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDiscord,
  firstCustomId,
  GUILD_ID,
  member,
  MEMBER_ID,
  OFFICER,
  OFFICER_ROLE,
  PLAIN_MEMBER,
  run,
  SETUP_OPTIONS,
  setupCommandPayload,
  type DraftRow,
  type FakeDiscordData,
  type SetupOption,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import {
  setupDraftFingerprint,
  type SetupRoles,
} from "../../src/db/guild-config.ts";
import type { GuildRole } from "../../src/discord/client.ts";
import { REFUSED } from "../../src/lib/permissions.ts";
import { COMMANDS, ROUTER } from "../../src/handlers/registry.ts";
import { handlerDb, type Seed } from "./handler-db.ts";

const ADMINISTRATOR_BIT = 1n << 3n;
const MANAGE_ROLES_BIT = 1n << 28n;

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

const LABELS: Record<SetupOption, string> = {
  eboard_role: "E-board",
  events_directors_role: "Events Directors",
  events_committee_role: "Events Committee",
  treasury_role: "Treasury Committee",
  marketing_role: "Marketing Committee",
};

/** How the chosen roles are listed: E-board is saved as the admin role too. */
const SHOWN: Record<SetupOption, string> = {
  ...LABELS,
  eboard_role: "E-board (also admin)",
};

const CHOSEN: Record<SetupOption, GuildRole> = {
  eboard_role: role(fakeId(), { name: "Board" }),
  events_directors_role: role(fakeId(), { name: "Directors" }),
  events_committee_role: role(fakeId(), { name: "Committee" }),
  treasury_role: role(fakeId(), { name: "Treasury" }),
  marketing_role: role(fakeId(), { name: "Marketing" }),
};

function setupRolesOf(roles: Record<SetupOption, GuildRole>): SetupRoles {
  return {
    officerRoleId: roles.events_directors_role.id,
    adminRoleId: roles.eboard_role.id,
    eboardRoleId: roles.eboard_role.id,
    eventsCommitteeRoleId: roles.events_committee_role.id,
    treasuryRoleId: roles.treasury_role.id,
    marketingRoleId: roles.marketing_role.id,
  };
}

const FINGERPRINT = setupDraftFingerprint(setupRolesOf(CHOSEN));

/** The config row's roles once CHOSEN is saved. */
const CHOSEN_BINDINGS = {
  officer_role_id: CHOSEN.events_directors_role.id,
  admin_role_id: CHOSEN.eboard_role.id,
  eboard_role_id: CHOSEN.eboard_role.id,
  events_committee_role_id: CHOSEN.events_committee_role.id,
  treasury_role_id: CHOSEN.treasury_role.id,
  marketing_role_id: CHOSEN.marketing_role.id,
};

const ROLE_LIST = [
  role(GUILD_ID, { name: "@everyone", position: 0 }),
  ...Object.values(CHOSEN),
];

function setupPayload(
  roles: Partial<Record<SetupOption, GuildRole>> = {},
  fields: Record<string, unknown> = {},
  extraOptions: unknown[] = [],
) {
  return setupCommandPayload({ ...CHOSEN, ...roles }, fields, extraOptions);
}

async function world(
  fields: Seed = {},
  discordData: FakeDiscordData = { roles: ROLE_LIST },
) {
  const database = await handlerDb(fields);
  const { discord, edits } = fakeDiscord(discordData);
  return {
    ...database,
    edits,
    dependencies: dependenciesFor(database.db, discord),
  };
}

type World = Awaited<ReturnType<typeof world>>;

/** No roles were saved: the database holds no audit row for a binding. */
async function expectNothingSaved(w: World): Promise<void> {
  expect(await w.changes()).toEqual([]);
}

/** Runs /setup as `who` and returns the Confirm button's custom_id. */
async function showSetup(
  { dependencies, edits }: World,
  who: Record<string, unknown> = ADMINISTRATOR,
  roles: Partial<Record<SetupOption, GuildRole>> = {},
): Promise<string> {
  const before = edits.length;
  await run(ROUTER, setupPayload(roles, { member: who }), dependencies);
  return firstCustomId(edits[before]);
}

const FIXED_REFUSAL_TEXT = REFUSED.message;
const NO_DRAFT_TEXT = "no longer matches your latest /setup";

beforeEach(() => {
  spyOn(console, "error").mockImplementation(() => undefined);
});

describe("registration", () => {
  it("is hidden by default, top level, with five required role options described within Discord's limit", () => {
    const definition = (
      COMMANDS as readonly {
        name: string;
        default_member_permissions?: string;
        options?: readonly {
          name: string;
          type: number;
          required?: boolean;
          description: string;
        }[];
      }[]
    ).find((command) => command.name === "setup");

    expect(definition?.default_member_permissions).toBe("0");
    expect(
      definition?.options?.map(({ name, type, required }) => [
        name,
        type,
        required,
      ]),
    ).toEqual(
      SETUP_OPTIONS.map((name) => [
        name,
        ApplicationCommandOptionType.Role,
        true,
      ]),
    );
    for (const option of definition?.options ?? []) {
      expect(option.description.length).toBeGreaterThan(0);
      expect(option.description.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("/setup", () => {
  it("defers privately and shows the five roles, by the club's names, with a Confirm button", async () => {
    const { dependencies, edits } = await world();

    const { reply } = await run(ROUTER, setupPayload(), dependencies);

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(edits).toHaveLength(1);
    for (const name of SETUP_OPTIONS) {
      expect(edits[0]?.content).toContain(
        `${SHOWN[name]}: ${CHOSEN[name].name}`,
      );
    }
    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant these: none found. The server owner may also be able to.",
    );
    expect(edits[0]?.content).not.toMatch(/\bonly\b/i);
    expect(firstCustomId(edits[0])).toBe(`setup.confirm:0:${FINGERPRINT}`);
  });

  it("saves only a draft for this member, with the fingerprint Confirm carries", async () => {
    const w = await world();

    await run(ROUTER, setupPayload(), w.dependencies);

    expect(await w.drafts()).toEqual([
      expect.objectContaining({
        guild_id: GUILD_ID,
        actor_id: MEMBER_ID,
        officer_role_id: CHOSEN.events_directors_role.id,
        admin_role_id: CHOSEN.eboard_role.id,
        eboard_role_id: CHOSEN.eboard_role.id,
        events_committee_role_id: CHOSEN.events_committee_role.id,
        treasury_role_id: CHOSEN.treasury_role.id,
        marketing_role_id: CHOSEN.marketing_role.id,
        fingerprint: FINGERPRINT,
      }) as DraftRow,
    ]);
    await expectNothingSaved(w);
    expect(await w.claims()).toBe(0);
    expect(await w.config()).toBeNull();
  });

  it.each([
    ["a plain member", PLAIN_MEMBER, true],
    ["an officer", OFFICER, true],
    ["the bound admin role, which does not reach bindings", ADMIN, true],
    ["a non-admin before setup", PLAIN_MEMBER, false],
    [
      "high permission bits that are not Administrator",
      member({ permissions: String((1n << 54n) | 7n) }),
      false,
    ],
  ])("refuses %s, with no reply content", async (_label, who, setUp) => {
    const w = await world(setUp ? { config: configRow() } : {});

    const { reply, deferred } = await run(
      ROUTER,
      setupPayload({}, { member: who }),
      w.dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(deferred).toBe(false);
    expect(w.edits).toEqual([]);
    expect(await w.drafts()).toEqual([]);
  });

  describe("roles that cannot be bound", () => {
    it.each<[string, SetupOption, GuildRole, string]>([
      [
        "@everyone",
        "treasury_role",
        role(GUILD_ID, { name: "@everyone" }),
        "The Treasury Committee role can't be \\@everyone",
      ],
      [
        "a managed role",
        "eboard_role",
        role(fakeId(), { name: "Some Bot", managed: true }),
        "The E-board role can't be Some Bot, because an integration controls who holds it.",
      ],
    ])(
      "rejects %s, naming it, with no button or draft",
      async (_label, name, chosen, text) => {
        const w = await world();

        await run(ROUTER, setupPayload({ [name]: chosen }), w.dependencies);

        expect(w.edits[0]?.content).toContain(text);
        expect(w.edits[0]?.components).toEqual([]);
        expect(await w.drafts()).toEqual([]);
      },
    );
  });

  describe("hostile role names", () => {
    it("renders a hostile name as inert text that never pings or unfurls", async () => {
      const name = `@everyone <@&${OFFICER_ROLE}> [click](https://evil.example) **bold**\n# System \u202Ex\u200B discord.gg/abcdef`;
      const granter = role(fakeId(), {
        name,
        permissions: ADMINISTRATOR_BIT,
      });
      const { dependencies, edits } = await world(
        {},
        { roles: [...ROLE_LIST, granter] },
      );

      await run(
        ROUTER,
        setupPayload({
          treasury_role: role(CHOSEN.treasury_role.id, { name }),
        }),
        dependencies,
      );

      const content = edits[0]?.content ?? "";
      expect(content).not.toMatch(/(?<!\\)@everyone/);
      expect(content).not.toMatch(/(?<!\\)<@&/);
      expect(content).not.toMatch(/(?<!\\)\[click/);
      expect(content).not.toMatch(/(?<!\\)\*\*bold/);
      expect(content).not.toMatch(/\n#/);
      expect(content).not.toContain("‮");
      expect(content).not.toContain("​");
      expect(content).not.toMatch(/(?<!\\)discord\.gg/);
      expect(edits[0]).toMatchObject({
        allowed_mentions: { parse: [], users: [] },
        flags: MessageFlags.SuppressEmbeds,
      });
    });
  });

  it("ignores options it does not ask for, so nothing forges the audit actor", async () => {
    const w = await world();
    const forged = fakeId();

    await run(
      ROUTER,
      setupPayload({}, {}, [
        { name: "p_actor_id", type: 3, value: forged },
        { name: "p_guild_id", type: 3, value: forged },
      ]),
      w.dependencies,
    );
    await run(
      ROUTER,
      componentPayload(firstCustomId(w.edits[0]), { member: ADMINISTRATOR }),
      w.dependencies,
    );

    expect(await w.changes()).toEqual([
      { actor_id: MEMBER_ID, action: "role_bindings" },
    ]);
    expect(await w.config()).toMatchObject({
      guild_id: GUILD_ID,
      version: 1,
      ...CHOSEN_BINDINGS,
    });
  });

  it("says who could grant the roles, and that it could not check when the lookup fails", async () => {
    const manager = role(fakeId(), {
      name: "Mods",
      permissions: MANAGE_ROLES_BIT,
      position: 9,
    });
    const { dependencies, edits } = await world(
      {},
      { roles: [...ROLE_LIST, manager] },
    );
    const failing = await world({}, { roles: "fail" });

    await run(ROUTER, setupPayload(), dependencies);
    await run(ROUTER, setupPayload(), failing.dependencies);

    expect(edits[0]?.content).toContain(
      "Roles that may be able to grant these: Mods. The server owner may also be able to.",
    );
    expect(failing.edits[0]?.content).toContain("could not check");
    expect(failing.edits[0]?.components).toHaveLength(1);
  });
});

describe("Confirm", () => {
  const confirmId = (version = 0, fingerprint = FINGERPRINT) =>
    `setup.confirm:${String(version)}:${fingerprint}`;

  it("saves the five roles from the draft this member was shown, with E-board as admin", async () => {
    const w = await world();

    await run(ROUTER, componentPayload(await showSetup(w)), w.dependencies);

    expect(await w.changes()).toEqual([
      { actor_id: MEMBER_ID, action: "role_bindings" },
    ]);
    expect(await w.config()).toMatchObject({ version: 1, ...CHOSEN_BINDINGS });
    expect(w.edits[1]?.content).toContain("Saved.");
    for (const name of SETUP_OPTIONS) {
      expect(w.edits[1]?.content).toContain(
        `${SHOWN[name]}: ${CHOSEN[name].name}`,
      );
    }
    expect(w.edits[1]?.components).toEqual([]);
  });

  it.each([
    ["a plain member", { member: PLAIN_MEMBER }],
    ["an officer", { member: OFFICER }],
    ["the bound admin role", { member: ADMIN }],
    ["a former administrator", { member: member() }],
    ["a click on a message that is not private", { message: { flags: 0 } }],
  ])("refuses %s, even with a copied button", async (_label, fields) => {
    const w = await world({ config: configRow() });
    const customId = await showSetup(w);

    const { reply } = await run(
      ROUTER,
      componentPayload(customId, fields),
      w.dependencies,
    );

    expect(reply.data?.content).toBe(FIXED_REFUSAL_TEXT);
    expect(reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
    await expectNothingSaved(w);
    expect(await w.claims()).toBe(0);
    expect(w.edits).toHaveLength(1);
  });

  it("gives a replayed Confirm no second write", async () => {
    const w = await world();
    const payload = componentPayload(await showSetup(w));

    await run(ROUTER, payload, w.dependencies);
    await run(ROUTER, payload, w.dependencies);

    expect(await w.changes()).toHaveLength(1);
    expect(w.edits).toHaveLength(2);
  });

  it("lets one of two admins win the first setup and a rebind, with one audit row each", async () => {
    const w = await world();
    async function race(customId: string) {
      const before = w.edits.length;
      await Promise.all([
        run(ROUTER, componentPayload(customId), w.dependencies),
        run(ROUTER, componentPayload(customId), w.dependencies),
      ]);
      const texts = w.edits.slice(before).map((edit) => edit.content);
      expect(texts.filter((text) => text.includes("Saved."))).toHaveLength(1);
      expect(
        texts.filter((text) => text.includes("Someone else changed the roles")),
      ).toHaveLength(1);
    }

    await race(await showSetup(w));
    expect(await w.changes()).toHaveLength(1);
    await race(
      await showSetup(w, ADMINISTRATOR, {
        treasury_role: CHOSEN.marketing_role,
        marketing_role: CHOSEN.treasury_role,
      }),
    );

    expect(await w.changes()).toHaveLength(2);
    expect(await w.config()).toMatchObject({
      version: 2,
      treasury_role_id: CHOSEN.marketing_role.id,
    });
  });

  it.each<[string, (w: World) => Promise<Record<string, unknown>>]>([
    [
      "a fingerprint that is not the draft's",
      async (w) => {
        await showSetup(w);
        return componentPayload(confirmId(0, "0123456789abcdef"));
      },
    ],
    [
      "an earlier Confirm once /setup was run again with other roles",
      async (w) => {
        const first = await showSetup(w);
        await showSetup(w, ADMINISTRATOR, {
          treasury_role: CHOSEN.marketing_role,
          marketing_role: CHOSEN.treasury_role,
        });
        return componentPayload(first);
      },
    ],
    [
      "a draft older than an hour",
      async (w) => {
        const customId = await showSetup(w);
        await w.pg.query(
          "UPDATE public.setup_drafts SET created_at = now() - interval '3601 seconds'",
        );
        return componentPayload(customId);
      },
    ],
    [
      "another administrator's draft, even with the same button",
      async (w) =>
        componentPayload(await showSetup(w), {
          member: member({
            id: fakeId(),
            permissions: ADMINISTRATOR_PERMISSIONS,
          }),
        }),
    ],
  ])("refuses %s", async (_label, click) => {
    const w = await world();
    const payload = await click(w);

    await run(ROUTER, payload, w.dependencies);

    await expectNothingSaved(w);
    const reply = w.edits.at(-1);
    expect(reply?.content).toContain(NO_DRAFT_TEXT);
    expect(reply?.content).toContain("Nothing was changed");
    expect(reply?.components).toEqual([]);
  });

  it("refuses with a refresh message when someone saved first, leaving their roles", async () => {
    const w = await world({ config: configRow({ version: 3 }) });
    const customId = await showSetup(w);
    await w.setConfig(configRow({ version: 4 }));

    await run(ROUTER, componentPayload(customId), w.dependencies);

    await expectNothingSaved(w);
    expect(w.edits[1]?.content).toContain("Someone else changed the roles");
    expect(w.edits[1]?.components).toEqual([]);
    expect(await w.config()).toMatchObject({
      officer_role_id: OFFICER_ROLE,
      admin_role_id: ADMIN_ROLE,
      version: 4,
    });
  });

  it.each<[string, GuildRole[] | "fail", string]>([
    [
      "the Treasury Committee role was deleted",
      ROLE_LIST.filter((item) => item.id !== CHOSEN.treasury_role.id),
      "The Treasury Committee role could not be found, so nothing was changed.",
    ],
    [
      "the E-board role became managed",
      ROLE_LIST.map((item) =>
        item.id === CHOSEN.eboard_role.id ? { ...item, managed: true } : item,
      ),
      `The E-board role can't be ${CHOSEN.eboard_role.name}, because an integration controls who holds it.`,
    ],
    ["Discord can't confirm the roles", "fail", "nothing was changed"],
  ])("refuses when %s since the panel opened", async (_label, roles, text) => {
    const w = await world();
    const customId = await showSetup(w);
    const { discord, edits } = fakeDiscord({ roles });

    await run(
      ROUTER,
      componentPayload(customId),
      dependenciesFor(w.db, discord),
    );

    await expectNothingSaved(w);
    expect(edits[0]?.content).toContain(text);
    expect(edits[0]?.components).toEqual([]);
  });
});
