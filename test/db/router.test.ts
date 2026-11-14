import { generateKeyPairSync, sign } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { InteractionResponseType, MessageFlags } from "discord-api-types/v10";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { POST } from "../../api/interactions.ts";
import { discordServer } from "../support/discord-server.ts";
import {
  ADMIN,
  ADMIN_ROLE,
  ADMINISTRATOR,
  APP_ID,
  OFFICER_ROLE,
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
  modalRoute,
  noRow,
  refusal,
  tierOnly,
  type Handler,
} from "../../src/handlers/router.ts";
import { handlerDb, type Seed } from "./handler-db.ts";
import { createMigratedDb, MIGRATION_OWNER, queryAs } from "./harness.ts";
import { pgliteSql, testDatabaseUrl } from "../support/sql-client.ts";
import { asFetch, stubEnv } from "../support/stubs.ts";

// Only the interactions endpoint below uses these two.
const pending = { work: [] as Promise<unknown>[] };
void mock.module("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    pending.work.push(work);
  },
}));
const live = { database: undefined as PGlite | undefined };
void mock.module("../../src/db/neon.ts", () => ({
  neonRunner: () =>
    pgliteSql(() => {
      if (live.database === undefined) {
        throw new Error("the database is not set up");
      }
      return live.database;
    }),
}));

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

/**
 * The client the interactions endpoint really builds. Other tests build their own, so
 * only this shows that liveDependencies checks the live forum row before a send.
 */
describe("the client built by liveDependencies", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let database: PGlite;
  let discord: ReturnType<typeof discordServer>;

  function signed(payload: unknown): Request {
    const body = Buffer.from(JSON.stringify(payload));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(
      null,
      Buffer.concat([Buffer.from(timestamp), body]),
      privateKey,
    );
    return new Request("https://bot.example.test/api/interactions", {
      method: "POST",
      headers: {
        "x-signature-ed25519": signature.toString("hex"),
        "x-signature-timestamp": timestamp,
      },
      body,
    });
  }

  /** /task assign on the event, through the endpoint, waiting for its work. */
  async function assignOn(eventId: string): Promise<void> {
    const person = fakeId();
    const options = [
      { name: "person", type: 6, value: person },
      { name: "description", type: 3, value: "Book the room" },
      { name: "due", type: 3, value: "2099-01-10" },
      { name: "event", type: 3, value: eventId },
    ];
    const payload = commandPayload(
      "task",
      { member: member({ roles: [OFFICER_ROLE] }) },
      {
        options: [{ name: "assign", type: 1, options }],
        resolved: {
          users: { [person]: { id: person } },
          members: { [person]: {} },
        },
      },
    );
    expect((await POST(signed(payload))).status).toBe(200);
    expect(pending.work).toHaveLength(1);
    await Promise.all(pending.work);
  }

  async function eventWithPost(forumStatus: string) {
    const forumId = discord.addForum(GUILD_ID);
    await queryAs(
      database,
      MIGRATION_OWNER,
      `INSERT INTO public.managed_channels (guild_id, channel_id, status)
       VALUES ($1, $2, 'active')`,
      [GUILD_ID, forumId],
    );
    const threadId = discord.addThread({
      guild_id: GUILD_ID,
      parent_id: forumId,
    });
    const rows = await queryAs<{ id: string }>(
      database,
      MIGRATION_OWNER,
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
       VALUES ($1, $2, 'General meeting', '2099-01-15', $3, $4, 'active')
       RETURNING id`,
      [GUILD_ID, forumId, fakeId(), threadId],
    );
    await queryAs(
      database,
      MIGRATION_OWNER,
      `UPDATE public.managed_channels
       SET status = $2::public.managed_channel_status WHERE channel_id = $1`,
      [forumId, forumStatus],
    );
    const posts = () =>
      discord.requests.filter(
        ({ method, path }) =>
          method === "POST" && path.includes(`/channels/${threadId}/messages`),
      );
    return { eventId: rows[0]?.id ?? "", posts };
  }

  beforeAll(async () => {
    database = await createMigratedDb();
    live.database = database;
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, NULL, NULL, NULL, NULL)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
  });

  afterAll(() => database.close());

  beforeEach(() => {
    pending.work = [];
    discord = discordServer(APP_ID);
    const key = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    stubEnv("DISCORD_PUBLIC_KEY", key.toString("hex"));
    stubEnv("DISCORD_APP_ID", APP_ID);
    stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
    stubEnv("DISCORD_BOT_TOKEN", "test-bot-token");
    stubEnv("DATABASE_URL", testDatabaseUrl());
    // Only Discord is reached over HTTP. The database is the mocked runner above.
    spyOn(globalThis, "fetch").mockImplementation(asFetch(discord.fetch));
  });

  it("posts in the event's post while its forum is active", async () => {
    const { eventId, posts } = await eventWithPost("active");

    await assignOn(eventId);

    expect(posts()).not.toEqual([]);
  });

  it.each(["removed", "unavailable"])(
    "posts nothing once the forum is %s, and keeps the task",
    async (status) => {
      const { eventId, posts } = await eventWithPost(status);

      await assignOn(eventId);

      expect(posts()).toEqual([]);
      const { rows } = await database.query(
        `SELECT 1 FROM public.tasks WHERE event_id = $1`,
        [eventId],
      );
      expect(rows).toHaveLength(1);
    },
  );
});
