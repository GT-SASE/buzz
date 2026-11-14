import { generateKeyPairSync, sign } from "node:crypto";
import { inspect } from "node:util";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { jsonObject } from "../../test/support/json.ts";
import { stubGlobal, type FetchLike } from "../../test/support/stubs.ts";
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
  DiscordClientOptions,
  DiscordFailure,
  FailureAction,
  ManagedChannelCheck,
  ThreadTarget,
} from "./client.ts";
import {
  channelMessage,
  deferredEphemeralReply,
  ephemeralReply,
  followUp,
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

const MANAGED: ChannelTarget = {
  kind: "channel",
  guildId: GUILD,
  channelId: MANAGED_FORUM,
};
const UNMANAGED: ChannelTarget = {
  kind: "channel",
  guildId: GUILD,
  channelId: UNMANAGED_CHANNEL,
};
const THREAD_TARGET: ThreadTarget = {
  kind: "thread",
  guildId: GUILD,
  threadId: THREAD,
};

const SECRET_CONTENT = {
  content: escapeUserText(SECRET_TEXT),
  mentionUserIds: [],
};
const MESSAGE_BODY = channelMessage(SECRET_CONTENT);
const EDIT_BODY = messageEdit(SECRET_CONTENT);
const REPLY_BODY = interactionReply(SECRET_CONTENT);
const EPHEMERAL_BODY = ephemeralReply(SECRET_CONTENT);
const FOLLOW_UP_BODY = followUp(SECRET_CONTENT);
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

function client(
  managedCheck = check,
  options: Partial<DiscordClientOptions> = {},
) {
  return createDiscordClient({
    check: managedCheck,
    env: ENV,
    sleep,
    ...options,
  });
}

function spyCheck() {
  return mock((guildId: string, channelId: string) =>
    check.isManaged(guildId, channelId),
  );
}

function created(): Response {
  return Response.json({ id: CREATED_ID }, { status: 200 });
}

function tooMany(retryAfter?: string, body: object = {}): Response {
  const headers: Record<string, string> =
    retryAfter === undefined ? {} : { "retry-after": retryAfter };
  return Response.json(body, { status: 429, headers });
}

interface Server {
  /** What GET /channels/{id} answers, by ID. Unlisted IDs are a plain channel. */
  channels?: Record<string, object>;
  /** What GET @original answers. */
  original?: () => Response;
  /** What any other request answers. */
  send?: () => Response;
}

// Answers lookups by route, so that a test can look at only the writes.
function serve({ channels = {}, original, send = created }: Server = {}): void {
  fetchMock.mockImplementation((url, init) => {
    if (init?.method !== "GET") {
      return Promise.resolve(send());
    }
    if ((url as string).endsWith("/messages/@original")) {
      return Promise.resolve(
        original?.() ?? new Response(null, { status: 404 }),
      );
    }
    const id = (url as string).split("/").at(-1) ?? "";
    return Promise.resolve(
      Response.json({ id, type: 0, guild_id: GUILD, ...channels[id] }),
    );
  });
}

interface SentRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function requests(): SentRequest[] {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url: url as string,
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: jsonObject(
      (init?.body as string | undefined) ?? "{}",
      "the request body",
    ),
  }));
}

function writes(): SentRequest[] {
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
  stubGlobal("fetch", fetchMock);
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

describe("requests", () => {
  it("sends a channel message with the bot token and the built body", async () => {
    serve();

    const sent = await client().sendMessage(MANAGED, MESSAGE_BODY);

    const [request] = requests();
    expect(sent).toEqual({ id: CREATED_ID });
    expect(requests()).toHaveLength(1);
    expect(request?.url).toBe(`${API}/channels/${MANAGED_FORUM}/messages`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(request?.headers["User-Agent"]).toBe(
      "DiscordBot (https://github.com/GT-SASE/discordBot)",
    );
    expect(request?.body).toEqual({
      content: SECRET_TEXT,
      flags: 4,
      allowed_mentions: { parse: [], users: [] },
    });
  });

  it("edits the original interaction reply without sending the bot token", async () => {
    serve();

    await client().editInteractionReply(IN_MANAGED, EDIT_BODY);

    const [request] = writes();
    expect(request?.method).toBe("PATCH");
    expect(request?.url).toBe(
      `${API}/webhooks/${APP_ID}/${ENCODED_TOKEN}/messages/@original`,
    );
    expect(request?.headers.Authorization).toBeUndefined();
  });
});

describe("createThread", () => {
  it("posts in a managed forum", async () => {
    serve({ channels: { [MANAGED_FORUM]: { type: 15 } } });

    const thread = await client().createThread(MANAGED, THREAD_BODY);

    expect(thread).toEqual({ id: CREATED_ID, firstMessageId: CREATED_ID });
    expect(writes()[0]?.url).toBe(`${API}/channels/${MANAGED_FORUM}/threads`);
  });

  it("refuses a managed channel that is not a forum", async () => {
    serve({ channels: { [MANAGED_FORUM]: { type: 0 } } });

    const failure = await failureOf(
      client().createThread(MANAGED, THREAD_BODY),
    );

    expect(failure).toEqual({ kind: "not_forum", channelId: MANAGED_FORUM });
    expect(writes()).toEqual([]);
  });
});

describe("managed channel check", () => {
  it("sends to a thread whose parent Discord reports as managed", async () => {
    serve({ channels: { [THREAD]: { type: 11, parent_id: MANAGED_FORUM } } });

    await client().sendMessage(THREAD_TARGET, MESSAGE_BODY);

    expect(requests().map(({ method, url }) => [method, url])).toEqual([
      ["GET", `${API}/channels/${THREAD}`],
      ["POST", `${API}/channels/${THREAD}/messages`],
    ]);
  });

  it("cannot be talked past with a caller-supplied parent", async () => {
    serve({
      channels: { [UNMANAGED_CHANNEL]: { type: 11, parent_id: fakeId(50) } },
    });
    const target = {
      kind: "thread" as const,
      guildId: GUILD,
      threadId: UNMANAGED_CHANNEL,
      parentId: MANAGED_FORUM,
    };
    const isManaged = spyCheck();

    const failure = await failureOf(
      client({ isManaged }).sendMessage(target, MESSAGE_BODY),
    );

    expect(failure).toEqual({
      kind: "unmanaged_target",
      channelId: UNMANAGED_CHANNEL,
    });
    expect(isManaged).not.toHaveBeenCalledWith(GUILD, MANAGED_FORUM);
    expect(writes()).toEqual([]);
  });

  it.each<[string, object]>([
    ["a channel whose parent_id is a category", { type: 0 }],
    ["a thread with an unmanaged parent", { type: 11, parent_id: fakeId(50) }],
    ["a thread with no parent", { type: 11, parent_id: undefined }],
  ])("refuses %s", async (_label, channel) => {
    serve({
      channels: {
        [UNMANAGED_CHANNEL]: { parent_id: MANAGED_FORUM, ...channel },
      },
    });

    const failure = await failureOf(
      client().sendMessage(UNMANAGED, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>, DiscordFailure["kind"]]>([
    ["fails", () => Promise.reject(new Error("unavailable")), "check_failed"],
    ["answers loosely", () => Promise.resolve("yes"), "unmanaged_target"],
  ])("refuses the send when the check %s", async (_label, isManaged, kind) => {
    serve();
    const loose = { isManaged } as unknown as ManagedChannelCheck;

    const failure = await failureOf(
      client(loose).sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure.kind).toBe(kind);
    expect(writes()).toEqual([]);
  });

  it("refuses a malformed channel or guild ID before the check", async () => {
    const isManaged = mock<ManagedChannelCheck["isManaged"]>();
    const discord = client({ isManaged });

    for (const target of [
      { kind: "channel" as const, guildId: GUILD, channelId: "../users/@me" },
      { kind: "channel" as const, guildId: "../1", channelId: MANAGED_FORUM },
    ]) {
      expect(
        (await failureOf(discord.sendMessage(target, MESSAGE_BODY))).kind,
      ).toBe("invalid_target");
    }
    expect(isManaged).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, Server, () => Promise<unknown>]>([
    [
      "a channel managed only in another guild",
      {},
      () =>
        client().sendMessage(
          { kind: "channel", guildId: OTHER_GUILD, channelId: MANAGED_FORUM },
          MESSAGE_BODY,
        ),
    ],
  ])("refuses %s", async (_label, server, send) => {
    serve(server);

    expect((await failureOf(send())).kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });
});

describe("interaction replies", () => {
  it.each([
    [
      "replyToInteraction",
      (i: VerifiedInteraction) => client().replyToInteraction(i, REPLY_BODY),
    ],
    [
      "editInteractionReply",
      (i: VerifiedInteraction) => client().editInteractionReply(i, EDIT_BODY),
    ],
    [
      "sendFollowUp",
      (i: VerifiedInteraction) => client().sendFollowUp(i, FOLLOW_UP_BODY),
    ],
  ])("%s checks the signed channel before it sends", async (_name, send) => {
    serve();

    expect(await failureOf(send(IN_UNMANAGED))).toEqual({
      kind: "unmanaged_target",
      channelId: UNMANAGED_CHANNEL,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await send(
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
      parentId: undefined,
      token: INTERACTION_TOKEN,
    } as unknown as VerifiedInteraction;

    expect(
      (await failureOf(client().replyToInteraction(forged, REPLY_BODY))).kind,
    ).toBe("invalid_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("ephemeral responses", () => {
  it("sends to an unmanaged channel without calling the check", async () => {
    serve({ send: () => new Response(null, { status: 204 }) });
    const isManaged = mock<ManagedChannelCheck["isManaged"]>();

    await client({ isManaged }).respondEphemerally(
      IN_UNMANAGED,
      deferredEphemeralReply(),
    );

    expect(isManaged).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
    expect(requests()[0]?.url).toBe(
      `${API}/interactions/${INTERACTION}/${ENCODED_TOKEN}/callback`,
    );
  });

  it("still forces the mentions on what it sends", async () => {
    serve({ send: () => new Response(null, { status: 204 }) });

    await client().respondEphemerally(
      IN_UNMANAGED,
      ephemeralReply({
        content: escapeUserText("@everyone"),
        mentionUserIds: [],
      }),
    );

    expect(requests()[0]?.body).toEqual({
      type: 4,
      data: {
        content: String.raw`\@everyone`,
        flags: 68,
        allowed_mentions: { parse: [], users: [] },
      },
    });
  });

  it("refuses a public reply, even in a managed channel", async () => {
    expect(
      await failureOf(
        client().respondEphemerally(IN_MANAGED, REPLY_BODY as never),
      ),
    ).toEqual({ kind: "not_ephemeral" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("editEphemeralReply", () => {
  it("waits and reads again while the reply is missing", async () => {
    let reads = 0;
    serve({
      original: () =>
        ++reads > 3
          ? Response.json({ id: MESSAGE, flags: 64 })
          : Response.json({ code: 10008 }, { status: 404 }),
    });

    const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

    expect(edited.id).toBe(CREATED_ID);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
    expect(writes()).toHaveLength(1);
  });

  it("edits in an unmanaged channel when the reply is ephemeral", async () => {
    serve({ original: () => Response.json({ id: MESSAGE, flags: 64 + 128 }) });
    const isManaged = mock<ManagedChannelCheck["isManaged"]>();

    await client({ isManaged }).editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

    const url = `${API}/webhooks/${APP_ID}/${ENCODED_TOKEN}/messages/@original`;
    expect(isManaged).not.toHaveBeenCalled();
    expect(requests().map(({ method, url: sent }) => [method, sent])).toEqual([
      ["GET", url],
      ["PATCH", url],
    ]);
  });

  describe("when Discord fails for a moment", () => {
    // Answers the first edits with a 503, then normally.
    function faultyEdits(faults: number) {
      let patches = 0;
      fetchMock.mockImplementation((_url, init) => {
        if (init?.method === "GET") {
          return Promise.resolve(Response.json({ id: MESSAGE, flags: 64 }));
        }
        return Promise.resolve(
          ++patches <= faults ? new Response(null, { status: 503 }) : created(),
        );
      });
    }

    it("tries an edit again, with the same body", async () => {
      faultyEdits(2);

      const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
      expect(writes()).toHaveLength(3);
      expect(new Set(writes().map((write) => JSON.stringify(write))).size).toBe(
        1,
      );
    });

    it("does not repeat an edit that Discord refused", async () => {
      fetchMock.mockImplementation((_url, init) =>
        Promise.resolve(
          init?.method === "GET"
            ? Response.json({ id: MESSAGE, flags: 64 })
            : Response.json({ code: 10062 }, { status: 404 }),
        ),
      );

      expect(
        await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
      ).toMatchObject({ kind: "api", status: 404 });
      expect(writes()).toHaveLength(1);
    });

    it.each([
      [
        "a message",
        (target: DiscordClient) => target.sendMessage(MANAGED, MESSAGE_BODY),
      ],
      [
        "a first response",
        (target: DiscordClient) =>
          target.respondEphemerally(IN_UNMANAGED, EPHEMERAL_BODY),
      ],
    ])("does not repeat %s, which could post twice", async (_label, send) => {
      faultyEdits(1);

      await failureOf(send(client()));

      expect(writes()).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

describe("rate limits", () => {
  it.each([
    ["the header", tooMany("1.5"), 1500],
    ["a default when the header is unusable", tooMany("-1"), 1000],
  ])(
    "waits as long as %s says, then sends the same body",
    async (_label, limit, ms) => {
      fetchMock.mockResolvedValueOnce(limit).mockResolvedValueOnce(created());

      const sent = await client().sendMessage(MANAGED, MESSAGE_BODY);

      expect(sent.id).toBe(CREATED_ID);
      expect(sleep.mock.calls).toEqual([[ms]]);
      expect(
        new Set(requests().map(({ body }) => JSON.stringify(body))).size,
      ).toBe(1);
    },
  );

  it("stops after three attempts", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(tooMany("1")));

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({
      kind: "rate_limited",
      retryAfterMs: 1000,
      attempts: 3,
      scope: undefined,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it.each<[string, Record<string, string>, string]>([
    ["the scope header", { "x-ratelimit-scope": "global" }, "{}"],
  ])(
    "stops the run on a global limit known from %s",
    async (_label, headers, body) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          new Response(body, {
            status: 429,
            headers: { "retry-after": "1", ...headers },
          }),
        ),
      );

      const failure = await failureOf(
        client().sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure).toMatchObject({
        kind: "rate_limited",
        scope: "global",
        attempts: 1,
      });
      expect(sleep).not.toHaveBeenCalled();
      expect(actionForFailure(failure)).toBe("stop_run");
    },
  );
});

describe("errors", () => {
  it("reports a success response without an ID", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 200 }));

    expect(
      await failureOf(client().editMessage(MANAGED, MESSAGE, EDIT_BODY)),
    ).toEqual({ kind: "invalid_response", status: 200 });
  });

  it("keeps secrets out of the error and the client", async () => {
    const leaky = `${TOKEN} ${INTERACTION_TOKEN} ${SECRET_TEXT}`;
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 50035, message: leaky }, { status: 400 }),
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
      for (const secret of [TOKEN, INTERACTION_TOKEN, ENCODED_TOKEN]) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toContain(SECRET_TEXT);
    }
  });
});

describe("refusals that must not repeat", () => {
  it("stops after one request on a 401, for every later send", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 0 }, { status: 401 })),
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
  });

  it("still answers interactions after a 401, which do not use the token", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ code: 0 }, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const run = client();

    await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
    await run.replyToInteraction(IN_MANAGED, REPLY_BODY);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("makes no second attempt at an unavailable channel, but goes on to others", async () => {
    const other = fakeId(60);
    const managedBoth: ManagedChannelCheck = {
      isManaged: () => Promise.resolve(true),
    };
    fetchMock
      .mockResolvedValueOnce(Response.json({ code: 50001 }, { status: 403 }))
      .mockResolvedValueOnce(created());
    const run = client(managedBoth);

    const first = await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
    const second = await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
    await run.sendMessage(
      { kind: "channel", guildId: GUILD, channelId: other },
      MESSAGE_BODY,
    );

    expect(first.kind).toBe("channel_unavailable");
    expect(second).toEqual(first);
    expect(writes().map(({ url }) => url)).toEqual([
      `${API}/channels/${MANAGED_FORUM}/messages`,
      `${API}/channels/${other}/messages`,
    ]);
  });
});

describe("actionForFailure and mayHaveLanded", () => {
  const limited = (scope: string | undefined): DiscordFailure => ({
    kind: "rate_limited",
    retryAfterMs: 1,
    attempts: 1,
    scope,
  });
  const unavailable: DiscordFailure = {
    kind: "channel_unavailable",
    channelId: MANAGED_FORUM,
    status: 403,
    code: 50001,
  };

  it.each<[DiscordFailure, FailureAction, boolean]>([
    [{ kind: "unauthorized" }, "stop_run", false],
    [limited("global"), "stop_run", false],
    [limited("user"), "retry_later", false],
    [unavailable, "mark_channel_unavailable", false],
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

describe("reads", () => {
  it("reads roles with the bot token, keeping permissions as a BigInt", async () => {
    const role = {
      id: fakeId(20),
      name: "Hostile @everyone",
      permissions: String(1n << 54n),
      position: 3,
      managed: false,
    };
    fetchMock.mockResolvedValueOnce(Response.json([role]));

    expect(await client().getGuildRoles(GUILD)).toEqual([
      { ...role, permissions: 1n << 54n },
    ]);
    expect(requests()[0]?.url).toBe(`${API}/guilds/${GUILD}/roles`);
    expect(requests()[0]?.headers.Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("refuses a guild channel that Discord says is in another guild", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: THREAD, type: 15, guild_id: OTHER_GUILD }),
    );

    expect(await failureOf(client().getGuildChannel(GUILD, THREAD))).toEqual({
      kind: "invalid_response",
      status: 200,
    });
  });

  it("sends nothing for a malformed ID", async () => {
    const discord = client();

    for (const attempt of [
      discord.getGuildRoles("../1"),
      discord.getGuildMemberRoleIds(GUILD, "constructor"),
      discord.describeChannel("../1"),
    ]) {
      expect(await failureOf(attempt)).toEqual({ kind: "invalid_target" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => messageUrl("../1", THREAD, MESSAGE)).toThrow(RangeError);
    expect(messageUrl(GUILD, THREAD, MESSAGE)).toBe(
      `https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`,
    );
  });
});

describe("reopenThread", () => {
  const threadUnder = (parent_id: string) =>
    Response.json({ id: THREAD, type: 11, guild_id: GUILD, parent_id });

  it("reopens a managed thread, asking only to unarchive it", async () => {
    fetchMock.mockResolvedValueOnce(threadUnder(MANAGED_FORUM));
    fetchMock.mockResolvedValue(Response.json({ id: THREAD }));

    await client().reopenThread(THREAD_TARGET);

    expect(writes()).toEqual([
      expect.objectContaining({
        url: `${API}/channels/${THREAD}`,
        method: "PATCH",
        body: { archived: false },
      }) as SentRequest,
    ]);
  });

  it("does not reopen a thread outside a managed forum", async () => {
    fetchMock.mockResolvedValue(threadUnder(fakeId(99)));

    const failure = await failureOf(client().reopenThread(THREAD_TARGET));

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });
});
