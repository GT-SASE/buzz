import { generateKeyPairSync, sign } from "node:crypto";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { managedRow } from "../../test/support/interactions.ts";
import { jsonObject } from "../../test/support/json.ts";
import { serverError } from "../../test/support/sql-client.ts";
import { stubDb } from "../../test/support/stub-db.ts";
import { asFetch, type FetchLike } from "../../test/support/stubs.ts";
import { managedChannelCheck } from "../handlers/dependencies.ts";
import { ConfigError } from "../lib/config-error.ts";
import {
  actionForFailure,
  createDiscordClient,
  DiscordClientError,
  mayHaveLanded,
  messageUrl,
} from "./client.ts";
import type {
  ChannelTarget,
  DiscordClient,
  DiscordFailure,
  FailureAction,
  ManagedChannelCheck,
  ThreadTarget,
} from "./client.ts";
import {
  channelMessage,
  deferredEphemeralReply,
  ephemeralReply,
  interactionReply,
  messageEdit,
  threadCreate,
} from "./outbound.ts";
import { escapeUserText, plain } from "./safe-text.ts";
import { verifiedInteractionFrom, verifySignedRequest } from "./verify.ts";
import type { VerifiedInteraction } from "./verify.ts";
import { fakeId } from "../../test/support/ids.ts";

const TOKEN = "unit-test-bot-token-value";
const INTERACTION_TOKEN = "unit-test-interaction-token/with+symbols";
const ENCODED_TOKEN = encodeURIComponent(INTERACTION_TOKEN);
const SECRET_TEXT = "privatemessagetext";
const APP_ID = fakeId(9);
const ENV = { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID };
const API = "https://discord.com/api/v10";

const MANAGED_FORUM = fakeId(1);
const UNMANAGED_CHANNEL = fakeId(2);
const THREAD = fakeId(3);
const MESSAGE = fakeId(4);
const INTERACTION = fakeId(5);
const GUILD = fakeId(6);
const OTHER_GUILD = fakeId(7);
const CREATED_ID = fakeId(100);
const ORIGINAL = `${API}/webhooks/${APP_ID}/${ENCODED_TOKEN}/messages/@original`;

const MANAGED: ChannelTarget = {
  kind: "channel",
  guildId: GUILD,
  channelId: MANAGED_FORUM,
};
const UNMANAGED: ChannelTarget = { ...MANAGED, channelId: UNMANAGED_CHANNEL };
const THREAD_TARGET: ThreadTarget = {
  kind: "thread",
  guildId: GUILD,
  threadId: THREAD,
};

// A caller cannot vouch for a thread's parent: the client asks Discord.
const SUPPLIED_PARENT = {
  ...THREAD_TARGET,
  threadId: UNMANAGED_CHANNEL,
  parentId: MANAGED_FORUM,
};

const SECRET_CONTENT = {
  content: escapeUserText(SECRET_TEXT),
  mentionUserIds: [],
};
const MESSAGE_BODY = channelMessage(SECRET_CONTENT);
const EDIT_BODY = messageEdit(SECRET_CONTENT);
const REPLY_BODY = interactionReply(SECRET_CONTENT);
const THREAD_BODY = threadCreate({ ...SECRET_CONTENT, name: plain`Event` });

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_HEX = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");
const SIGNED_AT = "1700000000";

// The only way to get a VerifiedInteraction is to pass a real signature check.
function interactionIn(channel: Record<string, unknown>): VerifiedInteraction {
  const body = Buffer.from(
    JSON.stringify({
      id: INTERACTION,
      token: INTERACTION_TOKEN,
      guild_id: GUILD,
      channel,
    }),
  );
  const signature = sign(
    null,
    Buffer.concat([Buffer.from(SIGNED_AT), body]),
    privateKey,
  ).toString("hex");
  const signed = verifySignedRequest(
    { body, signature, timestamp: SIGNED_AT },
    PUBLIC_KEY_HEX,
    Number(SIGNED_AT) * 1000,
  );
  const interaction = signed && verifiedInteractionFrom(signed);
  if (interaction === undefined) {
    throw new Error("the test interaction did not verify");
  }
  return interaction;
}

const IN_MANAGED = interactionIn({ id: MANAGED_FORUM, type: 15 });
const IN_UNMANAGED = interactionIn({ id: UNMANAGED_CHANNEL, type: 0 });

// Stands in for the database check, which knows channels and not threads.
const check: ManagedChannelCheck = {
  isManaged: (guildId, channelId) =>
    Promise.resolve(guildId === GUILD && channelId === MANAGED_FORUM),
};

const fetchMock = mock<FetchLike>();
const sleep = mock<(ms: number) => Promise<void>>();

function client(managedCheck = check) {
  return createDiscordClient({ check: managedCheck, env: ENV, sleep });
}

function created(): Response {
  return Response.json({ id: CREATED_ID }, { status: 200 });
}

function status(code: number, body: object = {}): Response {
  return Response.json(body, { status: code });
}

// Answers channel lookups by ID, so that a test can look at only the writes.
function serve(
  channels: Record<string, object> = {},
  original?: () => Response,
): void {
  fetchMock.mockImplementation((url, init) => {
    if (init?.method !== "GET") {
      return Promise.resolve(created());
    }
    if ((url as string).endsWith("/messages/@original")) {
      return Promise.resolve(original?.() ?? status(404));
    }
    const id = (url as string).split("/").at(-1) ?? "";
    return Promise.resolve(
      Response.json({ id, type: 0, guild_id: GUILD, ...channels[id] }),
    );
  });
}

function requests() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: jsonObject((init?.body as string | undefined) ?? "{}", "the body"),
  }));
}

function writes() {
  return requests().filter((request) => request.method !== "GET");
}

async function failureOf(attempt: Promise<unknown>): Promise<DiscordFailure> {
  const error: unknown = await attempt.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DiscordClientError);
  return (error as DiscordClientError).failure;
}

beforeEach(() => {
  fetchMock.mockReset();
  sleep.mockReset();
  sleep.mockResolvedValue(undefined);
  spyOn(globalThis, "fetch").mockImplementation(asFetch(fetchMock));
});

it.each([
  ["missing token", { DISCORD_APP_ID: APP_ID }],
  ["prefixed token", { ...ENV, DISCORD_BOT_TOKEN: `Bot ${TOKEN}` }],
  ["missing application ID", { DISCORD_BOT_TOKEN: TOKEN }],
])("refuses a %s without quoting it", (_label, env) => {
  const attempt = () => createDiscordClient({ check, env });

  expect(attempt).toThrow(ConfigError);
  expect(attempt).not.toThrow(TOKEN);
});

describe("sends", () => {
  it("sends a channel message with the bot token and the built body", async () => {
    serve();

    expect(await client().sendMessage(MANAGED, MESSAGE_BODY)).toEqual({
      id: CREATED_ID,
    });
    expect(requests()).toEqual([
      {
        url: `${API}/channels/${MANAGED_FORUM}/messages`,
        method: "POST",
        headers: expect.objectContaining({
          Authorization: `Bot ${TOKEN}`,
          "User-Agent": "DiscordBot (https://github.com/GT-SASE/discordBot)",
        }) as Record<string, string>,
        body: {
          content: SECRET_TEXT,
          flags: 4,
          allowed_mentions: { parse: [], users: [] },
        },
      },
    ]);
  });

  it("creates a thread only in a managed forum", async () => {
    serve({ [MANAGED_FORUM]: { type: 15 } });
    expect(await client().createThread(MANAGED, THREAD_BODY)).toEqual({
      id: CREATED_ID,
      firstMessageId: CREATED_ID,
    });

    fetchMock.mockClear();
    serve({ [MANAGED_FORUM]: { type: 0 } });
    expect(
      await failureOf(client().createThread(MANAGED, THREAD_BODY)),
    ).toEqual({ kind: "not_forum", channelId: MANAGED_FORUM });
    expect(writes()).toEqual([]);
  });
});

describe("the managed channel check", () => {
  it("sends to a thread whose parent Discord reports as managed", async () => {
    serve({ [THREAD]: { type: 11, parent_id: MANAGED_FORUM } });

    await client().sendMessage(THREAD_TARGET, MESSAGE_BODY);

    expect(requests().map(({ method, url }) => [method, url])).toEqual([
      ["GET", `${API}/channels/${THREAD}`],
      ["POST", `${API}/channels/${THREAD}/messages`],
    ]);
  });

  it.each<[string, Record<string, object>, ChannelTarget | ThreadTarget]>([
    ["a channel under a managed category", {}, UNMANAGED],
    [
      "a thread with an unmanaged parent",
      { [UNMANAGED_CHANNEL]: { type: 11, parent_id: fakeId(50) } },
      UNMANAGED,
    ],
    [
      "a thread with a caller-supplied managed parent",
      { [UNMANAGED_CHANNEL]: { type: 11, parent_id: fakeId(50) } },
      SUPPLIED_PARENT,
    ],
    [
      "a channel managed only in another guild",
      {},
      { ...MANAGED, guildId: OTHER_GUILD },
    ],
  ])("refuses %s", async (_label, channels, target) => {
    serve({ [UNMANAGED_CHANNEL]: { parent_id: MANAGED_FORUM }, ...channels });

    expect(
      (await failureOf(client().sendMessage(target, MESSAGE_BODY))).kind,
    ).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses a malformed ID before the check or any request", async () => {
    const isManaged = mock<ManagedChannelCheck["isManaged"]>();
    const discord = client({ isManaged });

    for (const attempt of [
      discord.sendMessage(
        { ...MANAGED, channelId: "../users/@me" },
        MESSAGE_BODY,
      ),
      discord.sendMessage({ ...MANAGED, guildId: "../1" }, MESSAGE_BODY),
      discord.getGuildRoles("../1"),
      discord.describeChannel("../1"),
    ]) {
      expect((await failureOf(attempt)).kind).toBe("invalid_target");
    }
    expect(isManaged).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => messageUrl("../1", THREAD, MESSAGE)).toThrow(RangeError);
  });

  it("comes from the database, and refuses the send when it cannot answer", async () => {
    const removed = stubDb(() => ({
      rows: [managedRow(MANAGED_FORUM, "removed")],
    }));
    const broken = stubDb(() => serverError("XX000"));
    const isManaged = (db: ReturnType<typeof stubDb>["db"]) =>
      managedChannelCheck(db).isManaged(GUILD, MANAGED_FORUM);

    expect(
      await isManaged(stubDb(() => ({ rows: [managedRow(MANAGED_FORUM)] })).db),
    ).toBe(true);
    expect(await isManaged(removed.db)).toBe(false);
    expect(
      await failureOf(
        client(managedChannelCheck(broken.db)).createThread(
          MANAGED,
          THREAD_BODY,
        ),
      ),
    ).toEqual({ kind: "check_failed", channelId: MANAGED_FORUM });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("interaction replies", () => {
  it("checks the signed channel before it replies", async () => {
    serve();
    const reply = (interaction: VerifiedInteraction) =>
      client().replyToInteraction(interaction, REPLY_BODY);

    expect(await failureOf(reply(IN_UNMANAGED))).toEqual({
      kind: "unmanaged_target",
      channelId: UNMANAGED_CHANNEL,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await reply(
      interactionIn({ id: THREAD, type: 11, parent_id: MANAGED_FORUM }),
    );
    expect(requests()).toHaveLength(1);
  });

  it("refuses an interaction not made from a signed payload", async () => {
    const forged = {
      id: INTERACTION,
      guildId: GUILD,
      channelId: MANAGED_FORUM,
      channelType: 15,
      token: INTERACTION_TOKEN,
    } as unknown as VerifiedInteraction;

    expect(
      (await failureOf(client().replyToInteraction(forged, REPLY_BODY))).kind,
    ).toBe("invalid_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers ephemerally anywhere, but only with an ephemeral body", async () => {
    serve();
    const isManaged = mock<ManagedChannelCheck["isManaged"]>();
    const discord = client({ isManaged });

    await discord.respondEphemerally(IN_UNMANAGED, deferredEphemeralReply());
    expect(
      await failureOf(
        discord.respondEphemerally(IN_MANAGED, REPLY_BODY as never),
      ),
    ).toEqual({ kind: "not_ephemeral" });

    expect(isManaged).not.toHaveBeenCalled();
    expect(requests().map(({ url }) => url)).toEqual([
      `${API}/interactions/${INTERACTION}/${ENCODED_TOKEN}/callback`,
    ]);
  });

  it("waits for a missing ephemeral reply, then edits it", async () => {
    let reads = 0;
    serve({}, () =>
      ++reads > 3
        ? Response.json({ id: MESSAGE, flags: 64 })
        : status(404, { code: 10008 }),
    );

    await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
    expect(writes().map(({ method, url }) => [method, url])).toEqual([
      ["PATCH", ORIGINAL],
    ]);
    expect(writes()[0]?.headers.Authorization).toBeUndefined();
  });
});

describe("retries", () => {
  // Answers the first writes with a 503, then normally.
  function faultyWrites(faults: number) {
    let count = 0;
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        init?.method === "GET"
          ? Response.json({ id: MESSAGE, flags: 64 })
          : ++count <= faults
            ? status(503)
            : created(),
      ),
    );
  }

  it("tries an ephemeral edit again with the same body, but never a send", async () => {
    faultyWrites(2);
    await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
    expect(
      new Set(writes().map((write) => JSON.stringify(write))),
    ).toHaveProperty("size", 1);
    expect(writes()).toHaveLength(3);

    for (const send of [
      (c: DiscordClient) => c.sendMessage(MANAGED, MESSAGE_BODY),
      (c: DiscordClient) =>
        c.respondEphemerally(IN_UNMANAGED, ephemeralReply(SECRET_CONTENT)),
    ]) {
      fetchMock.mockClear();
      sleep.mockClear();
      faultyWrites(1);
      await failureOf(send(client()));
      expect(writes()).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("waits out a 429 as told, gives up after three, and stops at once on a global one", async () => {
    const limit = (headers: Record<string, string> = {}) =>
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "1.5", ...headers },
      });
    fetchMock.mockResolvedValueOnce(limit()).mockResolvedValueOnce(created());
    await client().sendMessage(MANAGED, MESSAGE_BODY);
    expect(sleep.mock.calls).toEqual([[1500]]);
    expect(new Set(writes().map(({ body }) => JSON.stringify(body))).size).toBe(
      1,
    );

    fetchMock.mockReset();
    fetchMock.mockImplementation(() => Promise.resolve(limit()));
    expect(
      await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY)),
    ).toMatchObject({
      kind: "rate_limited",
      attempts: 3,
    });

    fetchMock.mockReset();
    sleep.mockClear();
    fetchMock.mockImplementation(() =>
      Promise.resolve(limit({ "x-ratelimit-scope": "global" })),
    );
    const global = await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY));
    expect(global).toMatchObject({ scope: "global", attempts: 1 });
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("stops after one 401 for every later bot send, but still answers interactions", async () => {
    fetchMock.mockImplementation((_url, init) =>
      Promise.resolve(
        (init?.headers as Record<string, string>).Authorization
          ? status(401, { code: 0 })
          : new Response(null, { status: 204 }),
      ),
    );
    const run = client();

    for (const attempt of [
      () => run.sendMessage(MANAGED, MESSAGE_BODY),
      () => run.editMessage(MANAGED, MESSAGE, EDIT_BODY),
      () => run.sendMessage(THREAD_TARGET, MESSAGE_BODY),
    ]) {
      expect(await failureOf(attempt())).toEqual({ kind: "unauthorized" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await run.replyToInteraction(IN_MANAGED, REPLY_BODY);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps secrets out of the error and the client", async () => {
    const leaky = `${TOKEN} ${INTERACTION_TOKEN} ${SECRET_TEXT}`;
    fetchMock.mockResolvedValueOnce(
      status(400, { code: 50035, message: leaky }),
    );
    fetchMock.mockRejectedValueOnce(new Error(leaky, { cause: leaky }));
    const instance = client();

    const thrown = [
      await instance
        .sendMessage(MANAGED, MESSAGE_BODY)
        .catch((reason: unknown) => reason),
      await instance
        .editInteractionReply(IN_MANAGED, EDIT_BODY)
        .catch((reason: unknown) => reason),
    ];

    for (const error of [...thrown, instance]) {
      const { message, stack } = error as Partial<Error>;
      const text = [
        message,
        stack,
        JSON.stringify(error),
        inspect(error, { depth: null, showHidden: true }),
      ].join("\n");
      for (const secret of [
        TOKEN,
        INTERACTION_TOKEN,
        ENCODED_TOKEN,
        SECRET_TEXT,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("actionForFailure and mayHaveLanded", () => {
  const limited = (scope: string | undefined): DiscordFailure => ({
    kind: "rate_limited",
    retryAfterMs: 1,
    attempts: 1,
    scope,
  });

  it.each<[DiscordFailure, FailureAction, boolean]>([
    [{ kind: "unauthorized" }, "stop_run", false],
    [limited("global"), "stop_run", false],
    [limited("user"), "retry_later", false],
    [
      {
        kind: "channel_unavailable",
        channelId: MANAGED_FORUM,
        status: 403,
        code: 50001,
      },
      "mark_channel_unavailable",
      false,
    ],
    [{ kind: "api", status: 400, code: 50035 }, "skip_item", false],
    // A locked thread says nothing about the text.
    [{ kind: "api", status: 400, code: 160005 }, "retry_later", false],
    [{ kind: "api", status: 500, code: undefined }, "retry_later", true],
    [{ kind: "network" }, "retry_later", true],
    [{ kind: "invalid_response", status: 200 }, "retry_later", true],
    [{ kind: "not_ephemeral" }, "retry_later", false],
  ])("maps %j to %s, landed %p", (failure, action, landed) => {
    expect(actionForFailure(failure)).toBe(action);
    expect(mayHaveLanded(failure)).toBe(landed);
  });
});
