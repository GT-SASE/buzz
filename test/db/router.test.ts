import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
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
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
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
const finished = mock();

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

const logged = mock();

beforeEach(() => {
  finished.mockReset();
  logged.mockReset();
  spyOn(console, "error").mockImplementation(logged);
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
  const panelButton = (prefix: string) =>
    componentRoute({
      prefix,
      fields: [],
      gate: noRow("config.view"),
      changesState: false,
      finish,
    });
  const forgedGate = {
    ...panelButton("config.x").gate,
    check: () => Promise.resolve({ kind: "allowed", resource: undefined }),
  } as unknown as ReturnType<typeof panelButton>["gate"];

  it.each<[string, () => Handler[], string]>([
    [
      "a route with an unmapped action",
      () => [
        {
          commands: [],
          routes: [
            { ...panelButton("config.x"), action: "__proto__" as Action },
          ],
        },
      ],
      "unmapped action",
    ],
    [
      "a copy of a real gate with its check replaced",
      () => [
        {
          commands: [],
          routes: [{ ...panelButton("config.x"), gate: forgedGate }],
        },
      ],
      "gate not made by this module",
    ],
    [
      "a public route with a finish step",
      () => [
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
      ],
      "is public, so it can only reply",
    ],
    [
      "a tier-only gate beside a reply, which would check no row at all",
      () => [
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
      ],
      "checks no row",
    ],
  ])("fails on %s", (_label, handlers, message) => {
    expect(() => createRouter(handlers())).toThrow(message);
  });
});

describe("names that exist on every object", () => {
  it.each(["constructor", "__proto__"])(
    "refuses %s as a command, subcommand, custom_id or picker, with no database read",
    async (name) => {
      const { dependencies, sent } = await setup();

      for (const payload of [
        commandPayload(name),
        commandPayload("event", {}, { options: [{ type: 1, name }] }),
        componentPayload(`${name}:1`),
        modalPayload(name),
      ]) {
        const { reply, deferred } = await run(router, payload, dependencies);
        expect(reply).toEqual(FIXED_REFUSAL);
        expect(deferred).toBe(false);
      }
      expect(
        (await run(router, autocompletePayload(name, "x"), dependencies)).reply,
      ).toEqual(NO_CHOICES);
      expect(sent()).toBe(0);
    },
  );
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
    ["an extra field", `config.test-change:3:${ID}:${ID}`],
    ["a version too big for the column", `config.test-change:2147483648:${ID}`],
    ["a bad UUID", "config.test-look:not-a-uuid"],
    ["a custom_id that is not a string", null],
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

    expect(finished).toHaveBeenCalledTimes(1);
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

    expect(finished).toHaveBeenCalledTimes(1);
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
    ["no permissions", { user: { id }, roles: [] }],
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

  it("answers a public route with no database or Discord settings at all", async () => {
    const missing = () => {
      throw new Error("no settings");
    };

    const test = await run(router, commandPayload("ping"), {
      db: missing,
      finishDb: missing,
      discord: missing,
    });
    const real = await run(ROUTER, commandPayload("ping"), {
      db: missing,
      finishDb: missing,
      discord: missing,
    });

    expect(test.reply).toEqual(FIXED_REFUSAL);
    expect(real.reply.data?.content).toBe("Pong!");
    expect(real.reply.data?.flags).toBe(
      MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    );
  });
});

describe("private replies", () => {
  it("defers a command privately, and a click as an update", async () => {
    const { dependencies, edits } = await setup();

    const command = await run(
      router,
      commandPayload("config.admin"),
      dependencies,
    );
    const click = await run(
      router,
      componentPayload(`config.test-look:${UUID}`),
      dependencies,
    );

    expect(command.reply).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(click.reply).toEqual({
      type: InteractionResponseType.DeferredMessageUpdate,
    });
    expect(edits[0]?.components).toEqual([]);
  });

  it.each([
    ["a public message", { id: fakeId(), flags: 0 }],
    ["no message", undefined],
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

  it("claims once before a state-changing route runs, and not for one that changes nothing", async () => {
    const { dependencies, claims, pg } = await setup();
    const payload = componentPayload(`config.test-change:3:${id}`);

    await run(
      router,
      componentPayload(`config.test-look:${UUID}`),
      dependencies,
    );
    expect(await claims()).toBe(0);
    await run(router, payload, dependencies);

    const claimed = await pg.query(
      "SELECT interaction_id FROM public.interaction_claims",
    );
    expect(claimed.rows).toEqual([{ interaction_id: payload.id }]);
    expect(await claims()).toBe(1);
  });

  it.each([
    ["a click", () => componentPayload(`config.test-change:3:${id}`)],
    ["a modal submit", () => modalPayload("config.test-submit")],
  ])(
    "runs a replayed %s once and answers Discord once",
    async (_label, build) => {
      const { dependencies, edits } = await setup();
      const payload = build();

      await run(router, payload, dependencies);
      await run(router, payload, dependencies);

      expect(finished).toHaveBeenCalledTimes(1);
      expect(edits).toHaveLength(1);
    },
  );

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

    expect(
      await run(
        router,
        commandPayload("config.boom"),
        dependenciesFor(db, rejected),
      ),
    ).toBeDefined();
  });
});

describe("routes on a row", () => {
  const rowRouter = createRouter([
    {
      commands: [],
      routes: [
        componentRoute({
          prefix: "event.test-row",
          fields: ["uuid"],
          gate: eventRow("event.close", () => Promise.resolve(rowResult)),
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

  it.each([
    ["an absent row", OFFICER, { ok: true, value: null }],
    [
      "another guild's row",
      OFFICER,
      { ok: true, value: { ...live, guild_id: fakeId() } },
    ],
    [
      "a deleted row",
      OFFICER,
      { ok: true, value: { ...live, deleted_at: "2030-01-01T00:00:00Z" } },
    ],
    ["a member without the tier", PLAIN_MEMBER, { ok: true, value: live }],
  ] as const)("gives %s the same refusal", async (_label, who, result) => {
    const { dependencies } = await setup();
    rowResult = result;

    const { reply } = await run(
      rowRouter,
      componentPayload(`event.test-row:${UUID}`, { member: who }),
      dependencies,
    );

    expect(reply).toEqual(FIXED_REFUSAL);
    expect(finished).not.toHaveBeenCalled();
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

    expect(finished).toHaveBeenCalledTimes(1);
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

  it.each<[string, Seed, Record<string, unknown>]>([
    [
      "a member below the tier",
      { config: configRow() },
      payload("x", { member: PLAIN_MEMBER }),
    ],
    [
      "text over the cap",
      { config: configRow() },
      payload("x".repeat(101), { member: OFFICER }),
    ],
    [
      "anyone before setup",
      { config: null },
      payload("x", { member: ADMINISTRATOR }),
    ],
  ])("offers nothing to %s", async (_label, seed, body) => {
    const { dependencies } = await setup(seed);

    const { reply } = await run(router, body, dependencies);

    expect(reply).toEqual(NO_CHOICES);
    expect(finished).not.toHaveBeenCalled();
  });
});

describe("a button on a message others can see", () => {
  const onPublic = mock();
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
  const other = componentRoute({
    prefix: "mytasks.private",
    fields: [],
    gate: noRow("mytasks"),
    changesState: false,
    finish: () =>
      Promise.resolve({ content: safe`Thanks`, mentionUserIds: [] }),
  });
  const router = createRouter([{ commands: [], routes: [clicked, other] }]);
  const onMessage = { message: { id: fakeId(), flags: 0 } };

  beforeEach(() => {
    onPublic.mockClear();
  });

  it("answers in a new private reply, leaving the message alone", async () => {
    const { db } = await handlerDb({ config: configRow() });
    const { discord, edits } = fakeDiscord();

    const ran = await run(
      router,
      componentPayload(`mytasks.public:${UUID}`, {
        member: PLAIN_MEMBER,
        ...onMessage,
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

  it.each<[string, Seed, string]>([
    ["before setup", { config: null }, `mytasks.public:${UUID}`],
    ["with a bad field", { config: configRow() }, "mytasks.public:nope"],
    ["for any other button", { config: configRow() }, "mytasks.private"],
  ])("still refuses %s", async (_label, seed, customId) => {
    const { db } = await handlerDb(seed);
    const { discord } = fakeDiscord();

    const ran = await run(
      router,
      componentPayload(customId, { member: PLAIN_MEMBER, ...onMessage }),
      dependenciesFor(db, discord),
    );

    expect(ran.reply).toEqual(FIXED_REFUSAL);
    expect(onPublic).not.toHaveBeenCalled();
  });
});
