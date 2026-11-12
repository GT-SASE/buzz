import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN,
  ADMINISTRATOR,
  OFFICER,
  PLAIN_MEMBER,
  autocompletePayload,
  commandPayload,
  componentPayload,
  configRow,
  dependenciesFor,
  fakeDiscord,
  GUILD_ID,
  member,
  modalPayload,
  run,
  verify,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { DiscordClientError } from "../../src/discord/client.ts";
import { plain, safe } from "../../src/discord/safe-text.ts";
import {
  COMMAND_POLICY,
  REFUSED,
  type Action,
} from "../../src/lib/permissions.ts";
import { COMMANDS, ROUTER } from "../../src/handlers/registry.ts";
import {
  autocompleteRoute,
  commandRoute,
  componentRoute,
  createRouter,
  eventRow,
  modalRoute,
  noRow,
  refusal,
  taskRow,
  tierOnly,
  valueOf,
  type Handler,
} from "../../src/handlers/router.ts";
import { handlerDb, type Seed } from "./handler-db.ts";

const FIXED_REFUSAL = {
  type: InteractionResponseType.ChannelMessageWithSource,
  data: {
    content: REFUSED.message,
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    allowed_mentions: { parse: [], users: [] },
  },
};
const MAYBE_SAVED =
  "Something went wrong and this may or may not have been saved. Check before trying again.";
const NO_CHOICES = {
  type: InteractionResponseType.ApplicationCommandAutocompleteResult,
  data: { choices: [] },
};

const UUID = "11111111-1111-4111-8111-111111111111";
const finished = vi.fn();

const change = componentRoute({
  prefix: "config.test-change",
  fields: ["version", "snowflake"],
  gate: noRow("config.change"),
  changesState: true,
  finish: (_ctx, _resource, values) => {
    finished(values);
    return Promise.resolve({ content: safe`done`, mentionUserIds: [] });
  },
});
const look = componentRoute({
  prefix: "config.test-look",
  fields: ["uuid"],
  gate: noRow("config.view"),
  changesState: false,
  finish: (_ctx, _resource, values) => {
    finished(values);
    return Promise.resolve({ content: safe`seen`, mentionUserIds: [] });
  },
});
const submit = modalRoute({
  prefix: "config.test-submit",
  fields: [],
  gate: noRow("config.change"),
  changesState: true,
  finish: () => {
    finished("modal");
    return Promise.resolve({ content: safe`sent`, mentionUserIds: [] });
  },
});

const TEST_HANDLERS: Handler[] = [
  {
    commands: [
      { name: "ping", description: "Public" },
      { name: "config.admin", description: "Admin tier" },
      { name: "config.boom", description: "Throws" },
      {
        name: "event",
        description: "With a subcommand",
        options: [{ type: 1, name: "one", description: "One" }],
      },
    ],
    routes: [
      commandRoute({
        path: "ping",
        gate: noRow("ping"),
        reply: refusal,
      }),
      commandRoute({
        path: "config.admin",
        gate: noRow("config.view"),
        changesState: false,
        finish: () => {
          finished("admin");
          return Promise.resolve({ content: safe`hi`, mentionUserIds: [] });
        },
      }),
      commandRoute({
        path: "config.boom",
        gate: noRow("config.view"),
        changesState: false,
        finish: () => Promise.reject(new Error("row text")),
      }),
      commandRoute({
        path: "event one",
        gate: noRow("event.list"),
        changesState: false,
        finish: () => {
          finished("event one");
          return Promise.resolve({ content: safe`hi`, mentionUserIds: [] });
        },
      }),
      autocompleteRoute({
        path: "event one",
        action: "event.status",
        choices: (_ctx, scope, typed) => {
          finished({ scope, typed });
          return Promise.resolve([{ name: plain`Choice`, value: "value" }]);
        },
      }),
      change,
      look,
      submit,
    ],
  },
];

const router = createRouter(TEST_HANDLERS);

async function setup(fields: Seed = { config: configRow() }) {
  const database = await handlerDb(fields);
  const { discord, edits } = fakeDiscord();
  return {
    db: database.db,
    pg: database.pg,
    fail: (name: string) => {
      database.fail(name);
    },
    sent: () => database.sent(),
    claims: () => database.claims(),
    edits,
    dependencies: dependenciesFor(database.db, discord),
  };
}

const logged = vi.fn();

beforeEach(() => {
  finished.mockReset();
  logged.mockReset();
  vi.spyOn(console, "error").mockImplementation(logged);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Order follows src/handlers/modules.ts, then each handler's own list.
const EXPECTED_ROUTES = [
  ["command", "config", "config.view"],
  ["component", "config.view", "config.view"],
  ["component", "config.reminders-on", "config.change"],
  ["component", "config.reminders-off", "config.change"],
  ["component", "config.add", "config.change"],
  ["component", "config.remove", "config.change"],
  ["component", "config.remove-yes", "config.change"],
  ["command", "event create", "event.create"],
  ["command", "event link", "event.link"],
  ["command", "event status", "event.status"],
  ["command", "event list", "event.list"],
  ["command", "event close", "event.close"],
  ["command", "event delete", "event.delete"],
  ["component", "event.delete.confirm", "event.delete"],
  ["autocomplete", "event link", "event.link"],
  ["autocomplete", "event status", "event.status"],
  ["autocomplete", "event close", "event.close"],
  ["autocomplete", "event delete", "event.delete"],
  ["command", "event assign", "event.assign"],
  ["command", "event unassign", "event.unassign"],
  ["command", "event pickup", "event.pickup"],
  ["component", "event.sheet-done", "event.step_done"],
  ["component", "event.engage-done", "event.step_done"],
  ["component", "event.budget-ok", "event.approve_budget"],
  ["autocomplete", "event assign", "event.assign"],
  ["autocomplete", "event unassign", "event.unassign"],
  ["autocomplete", "event pickup", "event.pickup"],
  ["command", "mytasks", "mytasks"],
  ["command", "ping", "ping"],
  ["command", "setup", "setup"],
  ["component", "setup.confirm", "setup"],
  ["command", "task assign", "task.assign"],
  ["autocomplete", "task assign", "task.assign"],
  ["command", "task edit", "task.edit"],
  ["autocomplete", "task edit", "task.edit"],
  ["command", "task delete", "task.delete"],
  ["component", "task.delete-yes", "task.delete"],
  ["autocomplete", "task delete", "task.delete"],
  ["command", "task done", "task.done"],
  ["autocomplete", "task done", "task.done"],
  ["component", "task.done", "task.done"],
];

describe("the registered tables", () => {
  const definitions = COMMANDS as readonly {
    name: string;
    options?: readonly { type: number; name: string }[];
  }[];

  it("has a route for every registered command and subcommand", () => {
    const paths = definitions.flatMap((definition) => {
      const subcommands = (definition.options ?? []).filter(
        (option) => option.type === 1,
      );
      return subcommands.length > 0
        ? subcommands.map((option) => `${definition.name} ${option.name}`)
        : [definition.name];
    });
    const commandRoutes = ROUTER.routes
      .filter((route) => route.surface === "command")
      .map((route) => route.key);

    expect(paths.length).toBeGreaterThan(0);
    expect([...commandRoutes].sort()).toEqual([...paths].sort());
  });

  it("is exactly this table, so a change to it is a visible decision", () => {
    expect(
      ROUTER.routes.map(({ surface, key, action }) => [surface, key, action]),
    ).toEqual(EXPECTED_ROUTES);
  });

  it("maps the action of every route, including every custom_id prefix", () => {
    const unmapped = ROUTER.routes.filter(
      (route) => !COMMAND_POLICY.has(route.action),
    );

    expect(ROUTER.routes.length).toBeGreaterThan(0);
    expect(unmapped.map((route) => route.key)).toEqual([]);
  });

  it("has every state-changing route on an action that is not public", () => {
    for (const route of ROUTER.routes) {
      if (route.surface !== "autocomplete" && route.changesState) {
        expect(COMMAND_POLICY.get(route.action)).not.toBe("public");
      }
    }
  });
});

describe("createRouter", () => {
  const finish = () =>
    Promise.resolve({ content: safe`x`, mentionUserIds: [] });
  const adminCommand = (path: string) =>
    commandRoute({
      path,
      gate: noRow("config.view"),
      changesState: false,
      finish,
    });
  const panelButton = (prefix: string) =>
    componentRoute({
      prefix,
      fields: [],
      gate: noRow("config.view"),
      changesState: false,
      finish,
    });

  it("fails on a route with an unmapped action", () => {
    const unmapped = {
      ...adminCommand("config.x"),
      action: "not.mapped" as Action,
    };

    expect(() =>
      createRouter([
        {
          commands: [{ name: "config.x", description: "x" }],
          routes: [unmapped],
        },
      ]),
    ).toThrow("unmapped action");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "fails on a route whose action is %s",
    (action) => {
      expect(() =>
        createRouter([
          {
            commands: [],
            routes: [{ ...panelButton("config.x"), action: action as Action }],
          },
        ]),
      ).toThrow("unmapped action");
    },
  );

  it("fails on an autocomplete route for an action with no picker", () => {
    expect(() =>
      createRouter([
        {
          commands: [{ name: "config.x", description: "x" }],
          routes: [
            adminCommand("config.x"),
            autocompleteRoute({
              path: "config.x",
              action: "config.view" as "event.status",
              choices: () => Promise.resolve([]),
            }),
          ],
        },
      ]),
    ).toThrow("cannot use autocomplete");
  });

  it("fails on a registered command with no route", () => {
    expect(() =>
      createRouter([
        { commands: [{ name: "config.x", description: "x" }], routes: [] },
      ]),
    ).toThrow("Command config.x has no route");
  });

  it("fails on a subcommand with no route", () => {
    expect(() =>
      createRouter([
        {
          commands: [
            {
              name: "config",
              description: "x",
              options: [{ type: 1, name: "y", description: "y" }],
            },
          ],
          routes: [adminCommand("config.x")],
        },
      ]),
    ).toThrow("Command config y has no route");
  });

  it("fails on a command route that is not registered", () => {
    expect(() =>
      createRouter([{ commands: [], routes: [adminCommand("config.x")] }]),
    ).toThrow("Route config.x has no registered command");
  });

  it("fails on an autocomplete route that is not registered", () => {
    expect(() =>
      createRouter([
        {
          commands: [],
          routes: [
            autocompleteRoute({
              path: "event.x",
              action: "event.status",
              choices: () => Promise.resolve([]),
            }),
          ],
        },
      ]),
    ).toThrow("Route event.x has no registered command");
  });

  it("fails on a duplicate, even across files", () => {
    expect(() =>
      createRouter([
        { commands: [], routes: [panelButton("config.x")] },
        { commands: [], routes: [panelButton("config.x")] },
      ]),
    ).toThrow("Duplicate route config.x");
    expect(() =>
      createRouter([
        {
          commands: [{ name: "event.x", description: "x" }],
          routes: [
            commandRoute({
              path: "event.x",
              gate: noRow("event.list"),
              changesState: false,
              finish,
            }),
            autocompleteRoute({
              path: "event.x",
              action: "event.status",
              choices: () => Promise.resolve([]),
            }),
            autocompleteRoute({
              path: "event.x",
              action: "event.status",
              choices: () => Promise.resolve([]),
            }),
          ],
        },
      ]),
    ).toThrow("Duplicate route event.x");
  });

  it.each(["a:b", "", "Upper", "1a", "a b", "a".repeat(32)])(
    "fails on the prefix %j",
    (prefix) => {
      expect(() =>
        createRouter([{ commands: [], routes: [panelButton(prefix)] }]),
      ).toThrow("badly formed prefix");
    },
  );

  it.each([
    ["a command", () => adminCommand("event.x")],
    ["a button", () => panelButton("task.x")],
    ["a name that only starts the same", () => panelButton("configs.x")],
  ])("fails on %s whose key is not its action's family", (_label, route) => {
    expect(() => createRouter([{ commands: [], routes: [route()] }])).toThrow(
      "does not match action",
    );
  });

  it("fails on an autocomplete route from another family", () => {
    expect(() =>
      createRouter([
        {
          commands: [],
          routes: [
            autocompleteRoute({
              path: "task.x",
              action: "event.status",
              choices: () => Promise.resolve([]),
            }),
          ],
        },
      ]),
    ).toThrow("does not match action");
  });

  describe("gates", () => {
    const route = () => panelButton("config.x");

    it("fails on a hand-written gate", () => {
      const forged = {
        action: "config.view",
        check: () => Promise.resolve({ kind: "allowed", resource: undefined }),
      } as unknown as ReturnType<typeof route>["gate"];

      expect(() =>
        createRouter([
          { commands: [], routes: [{ ...route(), gate: forged }] },
        ]),
      ).toThrow("gate not made by this module");
    });

    it("fails on a copy of a real gate with its check replaced", () => {
      const forged = {
        ...route().gate,
        check: () => Promise.resolve({ kind: "allowed", resource: undefined }),
      } as unknown as ReturnType<typeof route>["gate"];

      expect(() =>
        createRouter([
          { commands: [], routes: [{ ...route(), gate: forged }] },
        ]),
      ).toThrow("gate not made by this module");
    });

    it("fails on a route claiming a different action from its gate", () => {
      expect(() =>
        createRouter([
          {
            commands: [],
            routes: [{ ...route(), action: "config.change" }],
          },
        ]),
      ).toThrow("gate not made by this module");
    });

    it("makes gates that cannot be changed", () => {
      expect(Object.isFrozen(noRow("config.view"))).toBe(true);
    });
  });

  describe("public routes", () => {
    it("fails on one with a finish step", () => {
      expect(() =>
        createRouter([
          {
            commands: [{ name: "ping", description: "x" }],
            routes: [
              commandRoute({
                path: "ping",
                gate: noRow("ping"),
                changesState: false,
                finish,
              }),
            ],
          },
        ]),
      ).toThrow("is public, so it can only reply");
    });

    it("fails on one that says it changes state", () => {
      const replying = commandRoute({
        path: "ping",
        gate: noRow("ping"),
        reply: refusal,
      });

      expect(() =>
        createRouter([
          {
            commands: [{ name: "ping", description: "x" }],
            routes: [{ ...replying, changesState: true }],
          },
        ]),
      ).toThrow("is public, so it can only reply");
    });

    it("accepts one that only replies", () => {
      expect(() =>
        createRouter([
          {
            commands: [{ name: "ping", description: "x" }],
            routes: [
              commandRoute({
                path: "ping",
                gate: noRow("ping"),
                reply: refusal,
              }),
            ],
          },
        ]),
      ).not.toThrow();
    });
  });
});

describe("names that exist on every object", () => {
  const NAMES = [
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "prototype",
  ];

  it.each(NAMES)(
    "refuses the command %s with no database read",
    async (name) => {
      const { dependencies, sent } = await setup();

      const { reply, deferred } = await run(
        router,
        commandPayload(name),
        dependencies,
      );

      expect(reply).toEqual(FIXED_REFUSAL);
      expect(deferred).toBe(false);
      expect(sent()).toBe(0);
    },
  );

  it.each(NAMES)("refuses the subcommand %s", async (name) => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      commandPayload("event", {}, { options: [{ type: 1, name }] }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it.each(NAMES)("refuses the custom_id prefix %s", async (name) => {
    const { dependencies, sent } = await setup();

    for (const payload of [
      componentPayload(name),
      componentPayload(`${name}:1`),
      modalPayload(name),
    ]) {
      expect((await run(router, payload, dependencies)).reply).toEqual(
        FIXED_REFUSAL,
      );
    }
    expect(sent()).toBe(0);
  });

  it.each(NAMES)("offers nothing for the autocomplete %s", async (name) => {
    const { dependencies, sent } = await setup();

    const { reply } = await run(
      router,
      autocompletePayload(name, "x"),
      dependencies,
    );

    expect(reply).toEqual(NO_CHOICES);
    expect(sent()).toBe(0);
  });
});

describe("custom_id parsing", () => {
  const ID = fakeId();

  it("accepts the exact form", async () => {
    const { dependencies } = await setup();

    await run(
      router,
      componentPayload(`config.test-change:3:${ID}`),
      dependencies,
    );

    expect(finished).toHaveBeenCalledWith([3, ID]);
  });

  it.each([
    ["no fields", "config.test-change"],
    ["too few fields", "config.test-change:3"],
    ["an extra field", `config.test-change:3:${ID}:${ID}`],
    ["a trailing separator", `config.test-change:3:${ID}:`],
    ["a doubled separator", `config.test-change::3:${ID}`],
    ["an empty field", `config.test-change:3:`],
    ["a leading separator", `:config.test-change:3:${ID}`],
    ["fields swapped", `config.test-change:${ID}:3`],
    ["a negative version", `config.test-change:-1:${ID}`],
    ["a padded version", `config.test-change:03:${ID}`],
    ["a hex version", `config.test-change:0x3:${ID}`],
    ["an exponent version", `config.test-change:1e3:${ID}`],
    ["a decimal version", `config.test-change:1.0:${ID}`],
    ["a version too big for the column", `config.test-change:2147483648:${ID}`],
    ["a version too long", `config.test-change:${"9".repeat(40)}:${ID}`],
    ["a padded ID", `config.test-change:3: ${ID}`],
    ["a short ID", "config.test-change:3:123"],
    ["an ID with letters", `config.test-change:3:${ID.slice(0, -1)}a`],
    ["an ID too long", `config.test-change:3:${ID}${"1".repeat(10)}`],
    ["the prefix in another case", `CONFIG.TEST-CHANGE:3:${ID}`],
    ["a near-miss prefix", `config.test-change2:3:${ID}`],
    ["over the length limit", `config.test-change:3:${ID}${"x".repeat(100)}`],
    ["a modal's prefix on a component", "config.test-submit"],
    ["a bad UUID", "config.test-look:not-a-uuid"],
    ["a UUID with an extra part", `config.test-look:${UUID}-1`],
    ["a newline", `config.test-change:3:${ID}\n`],
    ["an empty ID", ""],
  ])("refuses %s, with no database read", async (_label, customId) => {
    const { dependencies, sent } = await setup();

    const { reply } = await run(
      router,
      componentPayload(customId),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(finished).not.toHaveBeenCalled();
    expect(sent()).toBe(0);
  });

  it.each([[1], [null], [{}], [[]], [undefined]])(
    "refuses a custom_id of %j",
    async (customId) => {
      const { dependencies } = await setup();

      const { reply } = await run(
        router,
        componentPayload(customId),
        dependencies,
      );

      expect(reply).toEqual(FIXED_REFUSAL);
    },
  );

  it("does not treat another interaction type with a custom_id as a modal", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      modalPayload("config.test-submit", { type: 99 }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(finished).not.toHaveBeenCalled();
  });

  it("refuses a component's prefix on a modal", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      modalPayload(`config.test-change:3:${ID}`),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it("gives another guild's ID no special treatment: it only names a row", async () => {
    const { dependencies } = await setup();
    const foreign = fakeId();

    await run(
      router,
      componentPayload(`config.test-change:3:${foreign}`, {
        member: PLAIN_MEMBER,
      }),
      dependencies,
    );

    expect(finished).not.toHaveBeenCalled();
  });
});

describe("route.id", () => {
  it("builds what the parser accepts", () => {
    const id = fakeId();

    expect(change.id(3, id)).toBe(`config.test-change:3:${id}`);
  });

  it.each([
    ["a bad ID", () => change.id(1, "constructor")],
    ["a separator in an ID", () => change.id(1, "1:2")],
    ["a negative version", () => change.id(-1, fakeId())],
    ["a fractional version", () => change.id(1.5, fakeId())],
    ["a bad UUID", () => look.id("x")],
  ])("refuses to build one with %s", (_label, build) => {
    expect(build).toThrow(RangeError);
  });

  it("refuses to build one over Discord's limit", () => {
    const long = componentRoute({
      prefix: "config.test-long",
      fields: ["uuid", "uuid", "uuid"],
      gate: noRow("config.view"),
      changesState: false,
      finish: () => Promise.resolve({ content: safe`x`, mentionUserIds: [] }),
    });

    expect(() => long.id(UUID, UUID, UUID)).toThrow(RangeError);
  });
});

describe("authorization on every kind of interaction", () => {
  const id = fakeId();

  it.each([
    ["a command", () => commandPayload("config.admin", { member: OFFICER })],
    [
      "a subcommand",
      () =>
        commandPayload(
          "event",
          { member: PLAIN_MEMBER },
          { options: [{ type: 1, name: "one" }] },
        ),
    ],
    [
      "a button",
      () => componentPayload(`config.test-look:${UUID}`, { member: OFFICER }),
    ],
    ["a modal", () => modalPayload("config.test-submit", { member: OFFICER })],
  ])("refuses %s below the tier, before any work", async (_label, payload) => {
    const { dependencies, sent, claims } = await setup();

    const { reply, deferred } = await run(router, payload(), dependencies);

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(deferred).toBe(false);
    expect(finished).not.toHaveBeenCalled();
    // Only the config read, which the tier check needs.
    expect(sent()).toBe(1);
    expect(await claims()).toBe(0);
  });

  it.each([
    ["a role", ADMIN],
    ["the Administrator bit", ADMINISTRATOR],
  ])("allows %s", async (_label, who) => {
    const { dependencies } = await setup();

    await run(
      router,
      componentPayload(`config.test-change:3:${id}`, { member: who }),
      dependencies,
    );

    expect(finished).toHaveBeenCalledOnce();
  });

  it("reads the actor from each interaction, so a removed role counts at once", async () => {
    const { dependencies } = await setup();
    const customId = `config.test-change:3:${id}`;

    await run(
      router,
      componentPayload(customId, { member: ADMIN }),
      dependencies,
    );
    await run(
      router,
      componentPayload(customId, { member: PLAIN_MEMBER }),
      dependencies,
    );

    expect(finished).toHaveBeenCalledOnce();
  });

  it("refuses everything but public routes before setup", async () => {
    const { dependencies } = await setup({ config: null });

    const { reply } = await run(
      router,
      commandPayload("config.admin", { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it.each([
    ["no roles", { user: { id }, permissions: "0" }],
    ["no permissions", { user: { id }, roles: [] }],
    ["empty permissions", { user: { id }, roles: [], permissions: "" }],
    ["numeric permissions", { user: { id }, roles: [], permissions: 8 }],
    ["a bad role", { user: { id }, roles: ["x"], permissions: "8" }],
  ])("refuses a member with %s", async (_label, who) => {
    const { dependencies, sent } = await setup();

    const { reply } = await run(
      router,
      commandPayload("config.admin", { member: who }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(sent()).toBe(0);
  });

  it("does not see Administrator in high permission bits", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      commandPayload("config.admin", {
        member: member({ permissions: String((1n << 54n) | 7n) }),
      }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it("answers a public route with no database settings at all", async () => {
    const { reply } = await run(router, commandPayload("ping"), {
      db: () => {
        throw new Error("no database settings");
      },
      finishDb: () => {
        throw new Error("no database settings");
      },
      discord: () => {
        throw new Error("no bot token");
      },
    });

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it("refuses an interaction type it has no table for", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      commandPayload("config.admin", { type: 99 }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });
});

describe("private replies", () => {
  it("defers a command privately", async () => {
    const { dependencies, edits } = await setup();

    const { reply } = await run(
      router,
      commandPayload("config.admin"),
      dependencies,
    );

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(edits).toHaveLength(1);
  });

  it("defers a click as an update", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      componentPayload(`config.test-look:${UUID}`),
      dependencies,
    );

    expect(reply).toEqual({
      type: InteractionResponseType.DeferredMessageUpdate,
    });
  });

  it("replaces the buttons of a message it edits, unless the handler gives some", async () => {
    const { dependencies, edits } = await setup();

    await run(router, commandPayload("config.admin"), dependencies);

    expect(edits[0]?.components).toEqual([]);
  });

  it.each([
    ["a public message", { id: fakeId(), flags: 0 }],
    ["no flags", { id: fakeId() }],
    ["no message", undefined],
    ["flags that are not a number", { id: fakeId(), flags: "64" }],
  ])("refuses a click on %s, with no reads", async (_label, message) => {
    const { dependencies, sent } = await setup();

    const { reply } = await run(
      router,
      componentPayload(`config.test-look:${UUID}`, { message }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(finished).not.toHaveBeenCalled();
    expect(sent()).toBe(0);
  });

  it("uses one fixed refusal that says what authorize says", () => {
    expect(refusal().payload).toEqual(FIXED_REFUSAL);
  });
});

describe("claims", () => {
  const id = fakeId();

  it("claims once before a state-changing route runs", async () => {
    const { dependencies, claims, pg } = await setup();
    const payload = componentPayload(`config.test-change:3:${id}`);

    await run(router, payload, dependencies);

    const claimed = await pg.query(
      "SELECT interaction_id FROM public.interaction_claims",
    );
    expect(claimed.rows).toEqual([{ interaction_id: payload.id }]);
    expect(await claims()).toBe(1);
    expect(finished).toHaveBeenCalledOnce();
  });

  it("does not claim for a route that changes nothing", async () => {
    const { dependencies, claims } = await setup();

    await run(
      router,
      componentPayload(`config.test-look:${UUID}`),
      dependencies,
    );

    expect(await claims()).toBe(0);
  });

  it("runs a replayed interaction once and answers Discord once", async () => {
    const { dependencies, edits } = await setup();
    const payload = componentPayload(`config.test-change:3:${id}`);

    await run(router, payload, dependencies);
    await run(router, payload, dependencies);

    expect(finished).toHaveBeenCalledOnce();
    expect(edits).toHaveLength(1);
  });

  it("treats two different clicks as two interactions", async () => {
    const { dependencies } = await setup();

    await run(
      router,
      componentPayload(`config.test-change:3:${id}`),
      dependencies,
    );
    await run(
      router,
      componentPayload(`config.test-change:3:${id}`),
      dependencies,
    );

    expect(finished).toHaveBeenCalledTimes(2);
  });

  it("does not run if the claim fails, and says so privately", async () => {
    const { dependencies, edits, fail } = await setup();
    fail("claim_interaction");

    await run(
      router,
      componentPayload(`config.test-change:3:${id}`),
      dependencies,
    );

    expect(finished).not.toHaveBeenCalled();
    expect(edits[0]?.content).toBe(MAYBE_SAVED);
  });

  it("claims for a state-changing command, and not for a read-only one", async () => {
    const claiming = createRouter([
      {
        commands: [
          { name: "config.write", description: "Changes state" },
          { name: "config.read", description: "Changes nothing" },
        ],
        routes: [
          commandRoute({
            path: "config.write",
            gate: noRow("config.change"),
            changesState: true,
            finish: () =>
              Promise.resolve({ content: safe`x`, mentionUserIds: [] }),
          }),
          commandRoute({
            path: "config.read",
            gate: noRow("config.view"),
            changesState: false,
            finish: () =>
              Promise.resolve({ content: safe`x`, mentionUserIds: [] }),
          }),
        ],
      },
    ]);
    const { dependencies, claims } = await setup();

    await run(claiming, commandPayload("config.read"), dependencies);
    expect(await claims()).toBe(0);

    await run(claiming, commandPayload("config.write"), dependencies);
    expect(await claims()).toBe(1);
  });

  it("claims a modal submit too", async () => {
    const { dependencies } = await setup();
    const payload = modalPayload("config.test-submit");

    await run(router, payload, dependencies);
    await run(router, payload, dependencies);

    expect(finished).toHaveBeenCalledOnce();
  });
});

describe("databases", () => {
  it("reads with the short client, then finishes on the longer one", async () => {
    const short = await handlerDb({ config: configRow() });
    const long = await handlerDb({ config: configRow() });
    const { discord } = fakeDiscord();
    const dependencies = {
      db: () => short.db,
      finishDb: () => long.db,
      discord: () => discord,
    };

    await run(
      router,
      componentPayload(`config.test-change:3:${fakeId()}`),
      dependencies,
    );

    // The short client makes the one read before the reply; the claim and the rest
    // run on the longer one.
    expect(short.sent()).toBe(1);
    expect(await long.claims()).toBe(1);
    expect(await short.claims()).toBe(0);
  });

  it("does not build the longer client for a refusal", async () => {
    const { db } = await handlerDb({ config: configRow() });
    const { discord } = fakeDiscord();
    const finishDb = vi.fn(() => db);

    await run(router, commandPayload("config.admin", { member: OFFICER }), {
      db: () => db,
      finishDb,
      discord: () => discord,
    });

    expect(finishDb).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  const throwing = createRouter([
    {
      commands: [],
      routes: [
        componentRoute({
          prefix: "config.write-fails",
          fields: [],
          gate: noRow("config.change"),
          changesState: true,
          finish: () => Promise.reject(new Error("thrown")),
        }),
        componentRoute({
          prefix: "config.read-fails",
          fields: [],
          gate: noRow("config.view"),
          changesState: false,
          finish: () => Promise.reject(new Error("thrown")),
        }),
        componentRoute({
          prefix: "config.discord-fails",
          fields: [],
          gate: noRow("config.view"),
          changesState: false,
          finish: () =>
            Promise.reject(
              new DiscordClientError("read guild", {
                kind: "api",
                status: 403,
                code: 50001,
              }),
            ),
        }),
        componentRoute({
          prefix: "config.budget-fails",
          fields: [],
          gate: noRow("config.view"),
          changesState: false,
          finish: () =>
            Promise.reject(
              new DiscordClientError("read guild", {
                kind: "budget_exhausted",
              }),
            ),
        }),
      ],
    },
  ]);

  it("does not claim a failed write saved nothing, since it may have", async () => {
    const { dependencies, edits } = await setup();

    await run(throwing, componentPayload("config.write-fails"), dependencies);

    expect(edits[0]?.content).toBe(MAYBE_SAVED);
  });

  it("says try again when a read-only route fails", async () => {
    const { dependencies, edits } = await setup();

    await run(throwing, componentPayload("config.read-fails"), dependencies);

    expect(edits[0]?.content).toContain("Please try again");
    expect(edits[0]?.content).not.toContain("may or may not");
  });

  it("logs the kind, status and code of a Discord failure", async () => {
    const { dependencies } = await setup();

    await run(throwing, componentPayload("config.discord-fails"), dependencies);

    expect(logged).toHaveBeenCalledWith(
      "Interaction failed: config.view: DiscordClientError kind=api status=403 code=50001",
    );
  });

  it("logs only the kind of a Discord failure with no status", async () => {
    const { dependencies } = await setup();

    await run(throwing, componentPayload("config.budget-fails"), dependencies);

    expect(logged).toHaveBeenCalledWith(
      "Interaction failed: config.view: DiscordClientError kind=budget_exhausted",
    );
  });

  it("says only try again when the first read fails", async () => {
    const { dependencies, fail } = await setup();
    fail("guild_config");

    const { reply, deferred } = await run(
      router,
      commandPayload("config.admin"),
      dependencies,
    );

    expect(reply.data?.content).toContain("Something went wrong");
    expect(reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
    expect(deferred).toBe(false);
  });

  it("shows a thrown error as the fixed text and logs only its type", async () => {
    const { dependencies, edits } = await setup();

    await run(router, commandPayload("config.boom"), dependencies);

    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toContain("Something went wrong");
    expect(JSON.stringify(logged.mock.calls)).toContain("config.view: Error");
    expect(JSON.stringify(logged.mock.calls)).not.toContain("row text");
  });

  it("resolves even if Discord refuses the edit, so waitUntil never rejects", async () => {
    const { db } = await setup();
    const { discord } = fakeDiscord();
    const rejected = {
      ...discord,
      editEphemeralReply: () => Promise.reject(new Error("thrown")),
    };

    await expect(
      run(router, commandPayload("config.boom"), dependenciesFor(db, rejected)),
    ).resolves.toBeDefined();
  });

  it("logs only a category and code for a database failure", () => {
    expect(() =>
      valueOf({
        ok: false,
        error: { category: "constraint", code: "23514" },
      }),
    ).toThrow("constraint:23514");
  });

  it("fails while Discord can still be told, if the bot token is missing", async () => {
    const { db } = await setup();

    await expect(
      run(router, commandPayload("config.admin"), {
        db: () => db,
        finishDb: () => db,
        discord: () => {
          throw new Error("DISCORD_BOT_TOKEN must be set");
        },
      }),
    ).rejects.toThrow("DISCORD_BOT_TOKEN");
    expect(finished).not.toHaveBeenCalled();
  });
});

describe("routes on a row", () => {
  const load = vi.fn();
  const rowRouter = createRouter([
    {
      commands: [],
      routes: [
        componentRoute({
          prefix: "event.test-row",
          fields: ["uuid"],
          gate: eventRow("event.close", (_ctx, values: readonly [string]) => {
            load(values);
            return Promise.resolve(rowResult);
          }),
          changesState: true,
          finish: (_ctx, row) => {
            finished(row);
            return Promise.resolve({ content: safe`x`, mentionUserIds: [] });
          },
        }),
        componentRoute({
          prefix: "task.test-row",
          fields: ["uuid"],
          gate: taskRow("task.done", () => Promise.resolve(taskResult)),
          changesState: true,
          finish: (_ctx, row) => {
            finished(row);
            return Promise.resolve({ content: safe`x`, mentionUserIds: [] });
          },
        }),
      ],
    },
  ]);
  type EventRowResult = Parameters<
    typeof valueOf<null | {
      guild_id: string;
      deleted_at: string | null;
    }>
  >[0];
  type TaskRowResult = Parameters<
    typeof valueOf<null | {
      guild_id: string;
      deleted_at: string | null;
      assignee_id: string;
    }>
  >[0];
  let rowResult: EventRowResult;
  let taskResult: TaskRowResult;

  const live = { guild_id: GUILD_ID, deleted_at: null };

  beforeEach(() => {
    load.mockReset();
  });

  it("hands the loader the parsed ID and the handler the loaded row", async () => {
    const { dependencies } = await setup();
    rowResult = { ok: true, value: live };

    await run(
      rowRouter,
      componentPayload(`event.test-row:${UUID}`, { member: OFFICER }),
      dependencies,
    );

    expect(load).toHaveBeenCalledWith([UUID]);
    expect(finished).toHaveBeenCalledWith(live);
  });

  it.each([
    ["an absent row", { ok: true, value: null }],
    [
      "another guild's row",
      { ok: true, value: { ...live, guild_id: fakeId() } },
    ],
    [
      "a deleted row",
      { ok: true, value: { ...live, deleted_at: "2030-01-01T00:00:00Z" } },
    ],
    [
      "a refused lookup",
      { ok: false, error: { category: "invalid_input", code: null } },
    ],
  ] as const)("gives %s the same refusal", async (_label, result) => {
    const { dependencies } = await setup();
    rowResult = result;

    const { reply } = await run(
      rowRouter,
      componentPayload(`event.test-row:${UUID}`, { member: OFFICER }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(finished).not.toHaveBeenCalled();
  });

  it("refuses a member without the tier, even for a real row", async () => {
    const { dependencies } = await setup();
    rowResult = { ok: true, value: live };

    const { reply } = await run(
      rowRouter,
      componentPayload(`event.test-row:${UUID}`, { member: PLAIN_MEMBER }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
  });

  it("says try again when the row cannot be read", async () => {
    const { dependencies } = await setup();
    rowResult = { ok: false, error: { category: "unavailable", code: null } };

    const { reply } = await run(
      rowRouter,
      componentPayload(`event.test-row:${UUID}`, { member: OFFICER }),
      dependencies,
    );

    expect(reply.data?.content).toContain("Something went wrong");
  });

  it("lets an assignee act on their own task, and nobody else's", async () => {
    const { dependencies } = await setup();
    const self = fakeId();
    taskResult = { ok: true, value: { ...live, assignee_id: self } };

    await run(
      rowRouter,
      componentPayload(`task.test-row:${UUID}`, {
        member: member({ id: self }),
      }),
      dependencies,
    );
    const { reply } = await run(
      rowRouter,
      componentPayload(`task.test-row:${UUID}`, { member: PLAIN_MEMBER }),
      dependencies,
    );

    expect(finished).toHaveBeenCalledOnce();
    expect(reply).toEqual(FIXED_REFUSAL);
  });
});

describe("autocomplete", () => {
  const subcommand = (typed: unknown) => ({
    type: 1,
    name: "one",
    options: [{ name: "event", type: 3, value: typed, focused: true }],
  });
  const payload = (typed: unknown, fields: Record<string, unknown> = {}) => ({
    ...autocompletePayload("event", typed, fields),
    data: { type: 1, name: "event", options: [subcommand(typed)] },
  });

  it("passes the scope and the text to the route", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      payload("text", { member: OFFICER }),
      dependencies,
    );

    expect(finished).toHaveBeenCalledWith({
      scope: { guildId: GUILD_ID },
      typed: "text",
    });
    expect(reply.data?.choices).toEqual([{ name: "Choice", value: "value" }]);
  });

  it.each([
    ["a member below the tier", payload("x", { member: PLAIN_MEMBER })],
    ["text over the cap", payload("x".repeat(101), { member: OFFICER })],
    ["text that is not a string", payload(1, { member: OFFICER })],
    [
      "a malformed member",
      payload("x", {
        member: { user: { id: fakeId() }, roles: "x" },
      }),
    ],
  ])("offers nothing to %s", async (_label, body) => {
    const { dependencies } = await setup();

    const { reply } = await run(router, body, dependencies);

    expect(reply).toEqual(NO_CHOICES);
    expect(finished).not.toHaveBeenCalled();
  });

  it("offers nothing before setup", async () => {
    const { dependencies } = await setup({ config: null });

    const { reply } = await run(
      router,
      payload("x", { member: ADMINISTRATOR }),
      dependencies,
    );

    expect(reply).toEqual(NO_CHOICES);
  });

  it("offers nothing when the config cannot be read", async () => {
    const { dependencies, fail } = await setup();
    fail("guild_config");

    const { reply } = await run(
      router,
      payload("x", { member: OFFICER }),
      dependencies,
    );

    expect(reply).toEqual(NO_CHOICES);
  });

  it("offers nothing when the route fails, and logs only the type", async () => {
    const failing = createRouter([
      {
        commands: [{ name: "event.x", description: "x" }],
        routes: [
          commandRoute({
            path: "event.x",
            gate: noRow("event.list"),
            changesState: false,
            finish: () =>
              Promise.resolve({ content: safe`x`, mentionUserIds: [] }),
          }),
          autocompleteRoute({
            path: "event.x",
            action: "event.status",
            choices: () => Promise.reject(new Error("thrown")),
          }),
        ],
      },
    ]);
    const { dependencies } = await setup();

    const { reply } = await run(
      failing,
      autocompletePayload("event.x", "y", { member: OFFICER }),
      dependencies,
    );

    expect(reply).toEqual(NO_CHOICES);
  });

  it("offers nothing for a subcommand group", async () => {
    const { dependencies } = await setup();

    const { reply } = await run(
      router,
      {
        ...payload("x", { member: OFFICER }),
        data: { type: 1, name: "event", options: [{ type: 2, name: "one" }] },
      },
      dependencies,
    );

    expect(reply).toEqual(NO_CHOICES);
  });
});

describe("the real table", () => {
  it("answers /ping with no database or Discord settings", async () => {
    const { reply } = await run(ROUTER, commandPayload("ping"), {
      db: () => {
        throw new Error("no settings");
      },
      finishDb: () => {
        throw new Error("no settings");
      },
      discord: () => {
        throw new Error("no settings");
      },
    });

    expect(reply.data?.content).toBe("Pong!");
    expect(reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
  });
});

describe("a button on a message others can see", () => {
  const onPublic = vi.fn();
  const clicked = componentRoute({
    prefix: "mytasks.public",
    fields: ["uuid"],
    onPublicMessage: true,
    gate: noRow("mytasks"),
    changesState: false,
    finish: (_ctx, _resource, values) => {
      onPublic(values);
      return Promise.resolve({
        content: safe`Thanks`,
        mentionUserIds: [],
      });
    },
  });
  const router = createRouter([{ commands: [], routes: [clicked] }]);

  it("answers in a new private reply, leaving the message alone", async () => {
    const { db } = await handlerDb({ config: configRow() });
    const { discord, edits } = fakeDiscord();

    const ran = await run(
      router,
      componentPayload(`mytasks.public:${UUID}`, {
        member: PLAIN_MEMBER,
        message: { id: fakeId(), flags: 0 },
      }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(onPublic).toHaveBeenCalledWith([UUID]);
    expect(edits[0]?.content).toBe("Thanks");
  });

  it("still checks the gate and the fields first", async () => {
    onPublic.mockClear();
    const { db } = await handlerDb({ config: null });
    const { discord } = fakeDiscord();
    const dependencies = dependenciesFor(db, discord);
    const onMessage = { message: { id: fakeId(), flags: 0 } };

    const beforeSetup = await run(
      router,
      componentPayload(`mytasks.public:${UUID}`, {
        member: PLAIN_MEMBER,
        ...onMessage,
      }),
      dependencies,
    );
    const badField = await run(
      router,
      componentPayload("mytasks.public:nope", {
        member: PLAIN_MEMBER,
        ...onMessage,
      }),
      dependencies,
    );

    expect(beforeSetup.reply).toEqual(FIXED_REFUSAL);
    expect(badField.reply).toEqual(FIXED_REFUSAL);
    expect(onPublic).not.toHaveBeenCalled();
  });

  it("leaves other buttons refused on a public message", async () => {
    const { db } = await handlerDb({ config: configRow() });
    const { discord } = fakeDiscord();
    const other = componentRoute({
      prefix: "mytasks.private",
      fields: [],
      gate: noRow("mytasks"),
      changesState: false,
      finish: () =>
        Promise.resolve({ content: safe`Thanks`, mentionUserIds: [] }),
    });

    const ran = await run(
      createRouter([{ commands: [], routes: [other] }]),
      componentPayload("mytasks.private", {
        member: PLAIN_MEMBER,
        message: { id: fakeId(), flags: 0 },
      }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply).toEqual(FIXED_REFUSAL);
  });
});

describe("a tier-only gate", () => {
  const finish = vi.fn(() =>
    Promise.resolve({ content: safe`Done`, mentionUserIds: [] }),
  );
  const route = componentRoute({
    prefix: "task.tiered",
    fields: ["uuid", "fingerprint"],
    gate: tierOnly("task.edit"),
    changesState: false,
    finish,
  });
  const router = createRouter([{ commands: [], routes: [route] }]);
  const FINGERPRINT = "0123456789abcdef";

  it("refuses the wrong tier at once and reads nothing but the config", async () => {
    finish.mockClear();
    const { db, sent } = await setup();
    const { discord } = fakeDiscord();

    const ran = await run(
      router,
      componentPayload(`task.tiered:${UUID}:${FINGERPRINT}`, {
        member: PLAIN_MEMBER,
      }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply).toEqual(FIXED_REFUSAL);
    expect(finish).not.toHaveBeenCalled();
    expect(sent()).toBe(1);
  });

  it("hands an allowed caller no row, reading nothing but the config", async () => {
    finish.mockClear();
    const { db, sent } = await setup();
    const { discord } = fakeDiscord();
    const { interaction, verified } = verify(
      componentPayload(`task.tiered:${UUID}:${FINGERPRINT}`, {
        member: OFFICER,
      }),
    );

    const outcome = await router.handle(
      interaction,
      verified,
      dependenciesFor(db, discord),
    );
    await outcome.after?.();

    expect(sent()).toBe(1);
    expect(finish).toHaveBeenCalledOnce();
    const [, resource] = finish.mock.calls[0] as unknown as unknown[];
    expect(resource).toBeUndefined();
  });

  it("refuses to load beside a reply, which would check no row at all", () => {
    expect(() =>
      createRouter([
        {
          commands: [{ name: "task", description: "x" }],
          routes: [
            commandRoute({
              path: "task",
              gate: tierOnly("task.edit"),
              reply: () => refusal(),
            }),
          ],
        },
      ]),
    ).toThrow("checks no row");
  });

  it.each([
    ["too short", "0123"],
    ["too long", `${FINGERPRINT}0`],
    ["uppercase", FINGERPRINT.toUpperCase()],
    ["not hex", "0123456789abcdeg"],
    ["empty", ""],
  ])("refuses a fingerprint that is %s", async (_name, value) => {
    const { db } = await handlerDb({ config: configRow() });
    const { discord } = fakeDiscord();

    const ran = await run(
      router,
      componentPayload(`task.tiered:${UUID}:${value}`, { member: OFFICER }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply).toEqual(FIXED_REFUSAL);
  });
});
