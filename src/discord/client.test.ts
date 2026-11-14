import { generateKeyPairSync, sign } from "node:crypto";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonObject } from "../../test/support/json.ts";
import { ConfigError } from "../lib/config-error.ts";
import {
  actionForFailure,
  createDiscordClient,
  DiscordClientError,
  DiscordErrorCode,
  messageUrl,
} from "./client.ts";
import type {
  ChannelTarget,
  DiscordClient,
  DiscordClientOptions,
  DiscordFailure,
  ManagedChannelCheck,
  ThreadTarget,
} from "./client.ts";
import {
  channelMessage,
  deferredEphemeralReply,
  deferredReply,
  ephemeralReply,
  followUp,
  interactionReply,
  messageEdit,
  pong,
  threadCreate,
  updateMessage,
} from "./outbound.ts";
import { escapeUserText, plain, safe } from "./safe-text.ts";
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

const fetchMock = vi.fn<typeof fetch>();
const sleep = vi.fn<(ms: number) => Promise<void>>();

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
  send?: () => Response | Promise<Response>;
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
    body: jsonObject(init?.body ?? "{}", "the request body"),
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
  sleep.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  function envWithToken(token: string) {
    return { ...ENV, DISCORD_BOT_TOKEN: token };
  }

  it.each([
    ["missing token", { DISCORD_APP_ID: APP_ID }],
    ["empty token", envWithToken("")],
    ["prefixed token", envWithToken(`Bot ${TOKEN}`)],
    ["token with a newline", envWithToken(`${TOKEN}\n`)],
    ["missing application ID", { DISCORD_BOT_TOKEN: TOKEN }],
  ])("refuses a %s without quoting it", (_label, env) => {
    const attempt = () => createDiscordClient({ check, env });

    expect(attempt).toThrow(ConfigError);
    expect(attempt).not.toThrow(TOKEN);
  });
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
    expect(request?.body).toEqual({
      content: SECRET_TEXT,
      flags: 4,
      allowed_mentions: { parse: [], users: [] },
    });
  });

  it("identifies itself in the format Discord requires", async () => {
    serve();

    await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(requests()[0]?.headers["User-Agent"]).toBe(
      "DiscordBot (https://github.com/GT-SASE/discordBot)",
    );
  });

  it("edits a message", async () => {
    serve();

    await client().editMessage(MANAGED, MESSAGE, EDIT_BODY);

    const [request] = writes();
    expect(request?.method).toBe("PATCH");
    expect(request?.url).toBe(
      `${API}/channels/${MANAGED_FORUM}/messages/${MESSAGE}`,
    );
  });

  it.each<[string, () => Promise<unknown>, string, string]>([
    [
      "replies to an interaction",
      () => client().replyToInteraction(IN_MANAGED, REPLY_BODY),
      "POST",
      `${API}/interactions/${INTERACTION}/${ENCODED_TOKEN}/callback`,
    ],
    [
      "edits the original interaction reply",
      () => client().editInteractionReply(IN_MANAGED, EDIT_BODY),
      "PATCH",
      `${API}/webhooks/${APP_ID}/${ENCODED_TOKEN}/messages/@original`,
    ],
  ])("%s without sending the bot token", async (_label, send, method, url) => {
    serve();

    await send();

    const [request] = writes();
    expect(request?.method).toBe(method);
    expect(request?.url).toBe(url);
    expect(request?.headers.Authorization).toBeUndefined();
  });
});

describe("createThread", () => {
  it.each([15, 16])("posts in a managed channel of type %i", async (type) => {
    serve({ channels: { [MANAGED_FORUM]: { type } } });

    const thread = await client().createThread(MANAGED, THREAD_BODY);

    expect(thread.id).toBe(CREATED_ID);
    expect(writes()[0]?.url).toBe(`${API}/channels/${MANAGED_FORUM}/threads`);
  });

  it.each([
    ["the one Discord gives", { message: { id: fakeId(101) } }, fakeId(101)],
    ["the post's own ID when Discord leaves it out", {}, CREATED_ID],
  ])("returns as the first message %s", async (_label, extra, first) => {
    serve({
      channels: { [MANAGED_FORUM]: { type: 15 } },
      send: () => Response.json({ id: CREATED_ID, ...extra }),
    });

    await expect(client().createThread(MANAGED, THREAD_BODY)).resolves.toEqual({
      id: CREATED_ID,
      firstMessageId: first,
    });
  });

  it("refuses a created post with no usable ID", async () => {
    serve({
      channels: { [MANAGED_FORUM]: { type: 15 } },
      send: () => Response.json({ id: "../1" }),
    });

    expect(
      await failureOf(client().createThread(MANAGED, THREAD_BODY)),
    ).toEqual({ kind: "invalid_response", status: 200 });
  });

  it.each([0, 5, 11])("refuses a channel of type %i", async (type) => {
    serve({ channels: { [MANAGED_FORUM]: { type } } });

    const failure = await failureOf(
      client().createThread(MANAGED, THREAD_BODY),
    );

    expect(failure).toEqual({ kind: "not_forum", channelId: MANAGED_FORUM });
    expect(writes()).toEqual([]);
  });

  it("refuses an unmanaged channel without asking Discord", async () => {
    const failure = await failureOf(
      client().createThread(UNMANAGED, THREAD_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a target that is not a channel, whatever its IDs", async () => {
    const target = { kind: "thread", guildId: GUILD, channelId: MANAGED_FORUM };

    for (const attempt of [
      // @ts-expect-error Only a channel can be the parent of a new thread.
      client().createThread(THREAD_TARGET, THREAD_BODY),
      client().createThread(target as unknown as ChannelTarget, THREAD_BODY),
    ]) {
      expect((await failureOf(attempt)).kind).toBe("invalid_target");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a thread passed off as a channel", async () => {
    serve({
      channels: {
        [THREAD]: { type: 11, parent_id: MANAGED_FORUM },
      },
    });

    const failure = await failureOf(
      client().createThread(
        { kind: "channel", guildId: GUILD, channelId: THREAD },
        THREAD_BODY,
      ),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });
});

describe("managed channel check", () => {
  it("does not look up a channel that is managed itself", async () => {
    serve();

    await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(requests().map(({ method }) => method)).toEqual(["POST"]);
  });

  it.each([10, 11, 12])(
    "sends to a thread of type %i whose parent Discord reports as managed",
    async (type) => {
      serve({ channels: { [THREAD]: { type, parent_id: MANAGED_FORUM } } });

      await client().sendMessage(THREAD_TARGET, MESSAGE_BODY);

      expect(requests().map(({ method, url }) => [method, url])).toEqual([
        ["GET", `${API}/channels/${THREAD}`],
        ["POST", `${API}/channels/${THREAD}/messages`],
      ]);
    },
  );

  it("cannot be talked past with a caller-supplied parent", async () => {
    serve({
      channels: {
        [UNMANAGED_CHANNEL]: { type: 11, parent_id: fakeId(50) },
      },
    });
    const target = {
      kind: "thread" as const,
      guildId: GUILD,
      threadId: UNMANAGED_CHANNEL,
      parentId: MANAGED_FORUM,
    };
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

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

  it.each([0, 2, 5, 13, 15, 16])(
    "ignores parent_id on channel type %i, where it is a category",
    async (type) => {
      serve({
        channels: { [UNMANAGED_CHANNEL]: { type, parent_id: MANAGED_FORUM } },
      });

      const failure = await failureOf(
        client().sendMessage(UNMANAGED, MESSAGE_BODY),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(writes()).toEqual([]);
    },
  );

  it.each([UNMANAGED_CHANNEL, undefined, null, "1", "../1", 5])(
    "refuses a thread whose parent_id is %j",
    async (parentId) => {
      serve({ channels: { [THREAD]: { type: 11, parent_id: parentId } } });

      const failure = await failureOf(
        client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(writes()).toEqual([]);
    },
  );

  it.each([
    [
      "missing access",
      () => Promise.resolve(Response.json({ code: 50001 }, { status: 403 })),
      {
        kind: "channel_unavailable",
        channelId: THREAD,
        status: 403,
        code: 50001,
      },
    ],
    [
      "a malformed answer",
      () => Promise.resolve(Response.json({})),
      { kind: "invalid_response", status: 200 },
    ],
    [
      "no response",
      () => Promise.reject(new TypeError("fetch failed")),
      { kind: "network" },
    ],
  ])(
    "refuses the send when the lookup gets %s",
    async (_l, answer, failure) => {
      fetchMock.mockImplementationOnce(answer);

      expect(
        await failureOf(client().sendMessage(THREAD_TARGET, MESSAGE_BODY)),
      ).toEqual(failure);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("refuses the send when the check itself fails", async () => {
    const broken: ManagedChannelCheck = {
      isManaged: () => Promise.reject(new Error("database unavailable")),
    };

    const failure = await failureOf(
      client(broken).sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("check_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["yes", 1, {}, undefined, null])(
    "does not treat %j from the check as managed",
    async (answer) => {
      serve();
      const loose = {
        isManaged: () => Promise.resolve(answer),
      } as unknown as ManagedChannelCheck;

      const failure = await failureOf(
        client(loose).sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(writes()).toEqual([]);
    },
  );

  it.each(["../../users/@me", "1/../2", ""])(
    "refuses the malformed ID %j before the check",
    async (channelId) => {
      const isManaged = vi.fn<ManagedChannelCheck["isManaged"]>();

      const failure = await failureOf(
        client({ isManaged }).sendMessage(
          { kind: "channel", guildId: GUILD, channelId },
          MESSAGE_BODY,
        ),
      );

      expect(failure.kind).toBe("invalid_target");
      expect(isManaged).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses a malformed message ID", async () => {
    const failure = await failureOf(
      client().editMessage(MANAGED, "../1", EDIT_BODY),
    );

    expect(failure.kind).toBe("invalid_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies to message edits", async () => {
    serve();

    const failure = await failureOf(
      client().editMessage(UNMANAGED, MESSAGE, EDIT_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });
});

describe("interaction replies", () => {
  const sends = [
    [
      "replyToInteraction",
      (interaction: VerifiedInteraction) =>
        client().replyToInteraction(interaction, REPLY_BODY),
    ],
    [
      "editInteractionReply",
      (interaction: VerifiedInteraction) =>
        client().editInteractionReply(interaction, EDIT_BODY),
    ],
    [
      "sendFollowUp",
      (interaction: VerifiedInteraction) =>
        client().sendFollowUp(interaction, FOLLOW_UP_BODY),
    ],
  ] as const;

  describe.each(sends)("%s", (_name, send) => {
    it("refuses an interaction from an unmanaged channel", async () => {
      expect(await failureOf(send(IN_UNMANAGED))).toEqual({
        kind: "unmanaged_target",
        channelId: UNMANAGED_CHANNEL,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends from a thread with a managed signed parent, with no lookup", async () => {
      serve();

      await send(
        interactionIn({ id: THREAD, type: 11, parent_id: MANAGED_FORUM }),
      );

      expect(requests().map(({ method }) => method)).toEqual([
        expect.stringMatching(/POST|PATCH/),
      ]);
    });

    it("refuses a thread with an unmanaged signed parent", async () => {
      const failure = await failureOf(
        send(
          interactionIn({ id: THREAD, type: 11, parent_id: UNMANAGED_CHANNEL }),
        ),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("ignores parent_id when the channel is not a thread", async () => {
      const failure = await failureOf(
        send(
          interactionIn({
            id: UNMANAGED_CHANNEL,
            type: 0,
            parent_id: MANAGED_FORUM,
          }),
        ),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("looks the parent up when the signed payload has none", async () => {
      serve({
        channels: { [THREAD]: { type: 11, parent_id: MANAGED_FORUM } },
      });

      await send(interactionIn({ id: THREAD, type: 11 }));

      expect(requests()[0]?.url).toBe(`${API}/channels/${THREAD}`);
      expect(writes()).toHaveLength(1);
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

      expect((await failureOf(send(forged))).kind).toBe("invalid_target");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("ephemeral responses", () => {
  it.each([
    ["an ephemeral reply", EPHEMERAL_BODY],
    ["an ephemeral defer", deferredEphemeralReply()],
  ])(
    "sends %s to an unmanaged channel without calling the check",
    async (_label, body) => {
      serve({ send: () => new Response(null, { status: 204 }) });
      const isManaged = vi.fn<ManagedChannelCheck["isManaged"]>();

      await client({ isManaged }).respondEphemerally(IN_UNMANAGED, body);

      expect(isManaged).not.toHaveBeenCalled();
      expect(requests()).toHaveLength(1);
      expect(requests()[0]?.url).toBe(
        `${API}/interactions/${INTERACTION}/${ENCODED_TOKEN}/callback`,
      );
      expect(requests()[0]?.headers.Authorization).toBeUndefined();
    },
  );

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

  it.each([
    ["a public reply", REPLY_BODY],
    ["a public defer", deferredReply()],
    [
      "a message update",
      updateMessage({ content: safe`hi`, mentionUserIds: [] }),
    ],
    ["a direct response that is not a reply", pong()],
  ])("refuses %s, even in a managed channel", async (_label, body) => {
    expect(
      await failureOf(client().respondEphemerally(IN_MANAGED, body as never)),
    ).toEqual({ kind: "not_ephemeral" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a public reply",
      (c: DiscordClient) => c.replyToInteraction(IN_UNMANAGED, REPLY_BODY),
    ],
    [
      "a public defer",
      (c: DiscordClient) => c.replyToInteraction(IN_UNMANAGED, deferredReply()),
    ],
    [
      "its edit",
      (c: DiscordClient) => c.editInteractionReply(IN_UNMANAGED, EDIT_BODY),
    ],
    [
      "a message update",
      (c: DiscordClient) =>
        c.replyToInteraction(
          IN_UNMANAGED,
          updateMessage({ content: safe`hi`, mentionUserIds: [] }),
        ),
    ],
  ])("keeps %s on the checked path", async (_label, send) => {
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

    expect((await failureOf(send(client({ isManaged })))).kind).toBe(
      "unmanaged_target",
    );
    expect(isManaged).toHaveBeenCalledWith(GUILD, UNMANAGED_CHANNEL);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("editEphemeralReply", () => {
  function originalAppearsAfter(misses: number) {
    let reads = 0;
    serve({
      original: () => {
        reads += 1;
        return reads > misses
          ? Response.json({ id: MESSAGE, flags: 64 })
          : Response.json({ code: 10008 }, { status: 404 });
      },
    });
  }

  it("waits and reads again while the reply is missing", async () => {
    originalAppearsAfter(3);

    const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

    expect(edited.id).toBe(CREATED_ID);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1000]);
    expect(writes()).toHaveLength(1);
  });

  it("gives up after the last wait, or sooner once its budget is spent", async () => {
    originalAppearsAfter(5);
    const short = client(check, { budget: { operationMs: 100 } });

    expect(
      await failureOf(short.editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
    ).toMatchObject({ kind: "api", status: 404 });
    expect(sleep).not.toHaveBeenCalled();
    expect(
      await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
    ).toMatchObject({ kind: "api", status: 404 });
    expect(requests()).toHaveLength(5);
    expect(writes()).toEqual([]);
  });

  it.each([64, 64 + 128, 64 + 4])(
    "edits, in an unmanaged channel, when flags are %i",
    async (flags) => {
      serve({ original: () => Response.json({ id: MESSAGE, flags }) });
      const isManaged = vi.fn<ManagedChannelCheck["isManaged"]>();

      const edited = await client({ isManaged }).editEphemeralReply(
        IN_UNMANAGED,
        EDIT_BODY,
      );

      const url = `${API}/webhooks/${APP_ID}/${ENCODED_TOKEN}/messages/@original`;
      expect(edited.id).toBe(CREATED_ID);
      expect(isManaged).not.toHaveBeenCalled();
      expect(requests().map(({ method, url: sent }) => [method, sent])).toEqual(
        [
          ["GET", url],
          ["PATCH", url],
        ],
      );
      expect(requests()[0]?.headers.Authorization).toBeUndefined();
    },
  );

  it.each([
    ["no flags", { id: MESSAGE }],
    ["zero flags", { id: MESSAGE, flags: 0 }],
    ["other flags", { id: MESSAGE, flags: 4 + 128 }],
    ["flags that are not a number", { id: MESSAGE, flags: "64" }],
  ])("refuses a message with %s", async (_label, original) => {
    serve({ original: () => Response.json(original) });

    const failure = await failureOf(
      client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY),
    );

    expect(failure).toEqual({ kind: "not_ephemeral" });
    expect(writes()).toEqual([]);
  });

  it.each([
    [
      "refused",
      () => Response.json({ code: 10062 }, { status: 404 }),
      { kind: "api", status: 404, code: 10062 },
      4,
    ],
    [
      "refused for another reason",
      () => Response.json({ code: 1 }, { status: 403 }),
      { kind: "api", status: 403, code: 1 },
      1,
    ],
    [
      "not JSON",
      () => new Response("<html>", { status: 200 }),
      { kind: "not_ephemeral" },
      1,
    ],
  ])(
    "refuses when the GET is %s, and writes nothing",
    async (_label, original, failure, reads) => {
      serve({ original });

      expect(
        await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
      ).toEqual(failure);
      expect(requests()).toHaveLength(reads);
      expect(writes()).toEqual([]);
    },
  );

  it("refuses when the GET never has a response", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const failure = await failureOf(
      client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY),
    );

    expect(failure).toEqual({ kind: "network" });
    expect(requests()).toHaveLength(4);
    expect(writes()).toEqual([]);
  });

  describe("when Discord fails for a moment", () => {
    // Answers the first calls of each method with a fault, then normally.
    function faultyServer(
      how: "503" | "no response",
      { gets = 0, patches = 0 }: { gets?: number; patches?: number },
    ) {
      let getCount = 0;
      let patchCount = 0;
      fetchMock.mockImplementation((_url, init) => {
        const faulty =
          init?.method === "GET" ? ++getCount <= gets : ++patchCount <= patches;
        if (faulty) {
          return how === "503"
            ? Promise.resolve(new Response(null, { status: 503 }))
            : Promise.reject(new TypeError("fetch failed"));
        }
        return Promise.resolve(
          init?.method === "GET"
            ? Response.json({ id: MESSAGE, flags: 64 })
            : created(),
        );
      });
    }

    const FAULTS = ["503", "no response"] as const;

    it.each(
      FAULTS.flatMap((how) => [
        [how, "reads", { gets: 2 }],
        [how, "edits", { patches: 2 }],
      ]) as [
        (typeof FAULTS)[number],
        string,
        { gets?: number; patches?: number },
      ][],
    )("tries again after a %s on two %s", async (how, _what, faults) => {
      faultyServer(how, faults);

      const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
      const [first, ...others] = writes();
      for (const other of others) {
        expect(other).toEqual(first);
      }
    });

    it("gives up after the last wait and reports the fault", async () => {
      faultyServer("503", { gets: 2, patches: 4 });

      expect(
        await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
      ).toEqual({ kind: "api", status: 503, code: undefined });
      expect(writes()).toHaveLength(4);
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
      expect(sleep).not.toHaveBeenCalled();
    });

    it("repeats a checked edit of the reply too", async () => {
      faultyServer("503", { patches: 2 });

      const edited = await client().editInteractionReply(IN_MANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(writes()).toHaveLength(3);
    });

    it.each([
      [
        "a follow-up",
        (target: DiscordClient) =>
          target.sendFollowUp(IN_MANAGED, FOLLOW_UP_BODY),
      ],
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
      faultyServer("503", { patches: 1 });

      await failureOf(send(client()));

      expect(writes()).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });
});

describe("rate limits", () => {
  it.each([
    ["the header", tooMany("1.5"), 1500],
    ["the body", tooMany(undefined, { retry_after: 0.25 }), 250],
  ])(
    "waits as long as %s says, then sends the same body",
    async (_label, limit, ms) => {
      fetchMock.mockResolvedValueOnce(limit).mockResolvedValueOnce(created());

      const sent = await client().sendMessage(MANAGED, MESSAGE_BODY);

      expect(sent.id).toBe(CREATED_ID);
      expect(sleep.mock.calls).toEqual([[ms]]);
      expect(requests()[1]?.body).toEqual(requests()[0]?.body);
    },
  );

  it.each(["soon", "-1", "Infinity", ""])(
    "uses a default wait when retry-after is %j",
    async (retryAfter) => {
      fetchMock
        .mockResolvedValueOnce(tooMany(retryAfter))
        .mockResolvedValueOnce(created());

      await client().sendMessage(MANAGED, MESSAGE_BODY);

      expect(sleep.mock.calls).toEqual([[1000]]);
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

  it("does not retry other failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));

    await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY));

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("budget", () => {
  // A clock that moves only when the client waits or a test moves it.
  function clocked(options: Partial<DiscordClientOptions> = {}) {
    let time = 1_000_000;
    return {
      advance: (ms: number) => (time += ms),
      options: {
        now: () => time,
        sleep: (ms: number) => {
          time += ms;
          sleep(ms).catch(() => undefined);
          return Promise.resolve();
        },
        ...options,
      },
    };
  }

  it.each([
    [
      "a reply",
      (c: DiscordClient) => c.replyToInteraction(IN_MANAGED, REPLY_BODY),
    ],
    [
      "an ephemeral response",
      (c: DiscordClient) => c.respondEphemerally(IN_MANAGED, EPHEMERAL_BODY),
    ],
  ])(
    "gives up on %s without sleeping when the wait does not fit",
    async (_label, send) => {
      const { options } = clocked();
      fetchMock.mockImplementationOnce(() => Promise.resolve(tooMany("2.5")));

      const failure = await failureOf(send(client(check, options)));

      expect(failure).toEqual({
        kind: "rate_limited",
        retryAfterMs: 2500,
        attempts: 1,
        scope: undefined,
      });
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("gives other operations longer, and spends it across retries", async () => {
    const { options } = clocked();
    fetchMock.mockImplementation(() => Promise.resolve(tooMany("5")));

    const failure = await failureOf(
      client(check, options).sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({
      kind: "rate_limited",
      retryAfterMs: 5000,
      attempts: 2,
      scope: undefined,
    });
    expect(sleep.mock.calls).toEqual([[5000]]);
  });

  it("shares the budget between a lookup and the send", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { options, advance } = clocked();
    fetchMock.mockImplementationOnce(() => {
      advance(3000);
      return Promise.resolve(
        Response.json({ type: 11, parent_id: MANAGED_FORUM, guild_id: GUILD }),
      );
    });
    fetchMock.mockImplementationOnce(() => Promise.resolve(created()));

    await client(check, options).sendMessage(THREAD_TARGET, MESSAGE_BODY);

    expect(timeout.mock.calls).toEqual([[8000], [5000]]);
  });

  it("does not start a request once the budget is spent", async () => {
    const { options, advance } = clocked();
    const slow: ManagedChannelCheck = {
      isManaged: () => {
        advance(2500);
        return Promise.resolve(true);
      },
    };

    const failure = await failureOf(
      client(slow, options).replyToInteraction(IN_MANAGED, REPLY_BODY),
    );

    expect(failure).toEqual({ kind: "budget_exhausted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a check that outlives the budget as check_failed", async () => {
    const hung: ManagedChannelCheck = {
      isManaged: () => new Promise<boolean>(() => undefined),
    };

    const failure = await failureOf(
      client(hung, { budget: { callbackMs: 5 } }).replyToInteraction(
        IN_MANAGED,
        REPLY_BODY,
      ),
    );

    expect(failure).toEqual({
      kind: "check_failed",
      channelId: MANAGED_FORUM,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it.each([
    ["unknown channel", 404, DiscordErrorCode.UnknownChannel, 10003],
    ["missing access", 403, DiscordErrorCode.MissingAccess, 50001],
    ["missing permissions", 403, DiscordErrorCode.MissingPermissions, 50013],
  ])(
    "marks %s as an unavailable channel",
    async (_label, status, code, number) => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ code, message: "refused" }, { status }),
      );

      const failure = await failureOf(
        client().sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure).toEqual({
        kind: "channel_unavailable",
        channelId: MANAGED_FORUM,
        status,
        code: number,
      });
    },
  );

  it.each([
    [
      "an unknown message, without blaming the channel",
      () => Response.json({ code: 10008 }, { status: 404 }),
      { kind: "api", status: 404, code: 10008 },
    ],
    [
      "another refusal, with its code",
      () => Response.json({ code: 50035 }, { status: 400 }),
      { kind: "api", status: 400, code: 50035 },
    ],
    [
      "an error response that holds no JSON",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      { kind: "api", status: 502, code: undefined },
    ],
    [
      "a success response without an ID",
      () => Response.json({}, { status: 200 }),
      { kind: "invalid_response", status: 200 },
    ],
  ])("reports %s", async (_label, answer, failure) => {
    fetchMock.mockResolvedValueOnce(answer());

    expect(
      await failureOf(client().editMessage(MANAGED, MESSAGE, EDIT_BODY)),
    ).toEqual(failure);
  });

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    expect(
      await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY)),
    ).toEqual({ kind: "network" });
  });

  it("does not blame the channel or token for an interaction route", async () => {
    for (const status of [401, 403, 404]) {
      fetchMock.mockResolvedValueOnce(
        Response.json({ code: 10062 }, { status }),
      );

      const failure = await failureOf(
        client().editInteractionReply(IN_MANAGED, EDIT_BODY),
      );

      expect(failure).toEqual({ kind: "api", status, code: 10062 });
    }
  });
});

describe("secrets", () => {
  const leaky = `${TOKEN} ${INTERACTION_TOKEN} ${SECRET_TEXT}`;
  const SECRETS = [TOKEN, INTERACTION_TOKEN, ENCODED_TOKEN, SECRET_TEXT];
  const failsLoudly: ManagedChannelCheck = {
    isManaged: () => Promise.reject(new Error(leaky)),
  };
  const shown = (value: unknown) =>
    [
      JSON.stringify(value),
      inspect(value, { depth: null, showHidden: true }),
    ].join("\n");

  it.each<[string, () => unknown, ManagedChannelCheck]>([
    [
      "an API error that echoes them",
      () =>
        fetchMock.mockImplementation(() =>
          Promise.resolve(
            Response.json({ code: 50035, message: leaky }, { status: 400 }),
          ),
        ),
      check,
    ],
    [
      "a network error that quotes them",
      () => fetchMock.mockRejectedValue(new Error(leaky, { cause: leaky })),
      check,
    ],
    ["a check that fails and quotes them", () => undefined, failsLoudly],
  ])("stay out of the error for %s", async (_label, arrange, managedCheck) => {
    arrange();

    const thrown: unknown[] = await Promise.all([
      client(managedCheck)
        .editInteractionReply(IN_MANAGED, EDIT_BODY)
        .catch((reason: unknown) => reason),
      client(managedCheck)
        .sendMessage(MANAGED, MESSAGE_BODY)
        .catch((reason: unknown) => reason),
    ]);

    for (const error of thrown) {
      expect(error).toBeInstanceOf(DiscordClientError);
      const { message, stack, cause } = error as DiscordClientError;
      expect(cause).toBeUndefined();
      const text = [message, stack, shown(error)].join("\n");
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("stay out of the client, a refused ephemeral edit and the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    serve({ original: () => Response.json({ id: MESSAGE, content: leaky }) });
    const instance = client();

    const refused: unknown = await instance
      .editEphemeralReply(IN_UNMANAGED, EDIT_BODY)
      .catch((reason: unknown) => reason);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(tooMany("1"))
      .mockResolvedValueOnce(created())
      .mockRejectedValueOnce(new Error(leaky));
    await instance.sendMessage(MANAGED, MESSAGE_BODY);
    await failureOf(instance.sendMessage(MANAGED, MESSAGE_BODY));

    expect(refused).toBeInstanceOf(DiscordClientError);
    const text = `${shown(refused)}${shown(instance)}`;
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("refusals that must not repeat", () => {
  it("stops after one request on a 401, for every later send", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 0 }, { status: 401 })),
    );
    const run = client();

    expect(await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY))).toEqual({
      kind: "unauthorized",
    });
    expect(await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY))).toEqual({
      kind: "unauthorized",
    });
    expect(
      await failureOf(run.editMessage(MANAGED, MESSAGE, EDIT_BODY)),
    ).toEqual({ kind: "unauthorized" });
    expect(
      await failureOf(run.sendMessage(THREAD_TARGET, MESSAGE_BODY)),
    ).toEqual({ kind: "unauthorized" });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
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

  it.each<[string, number, ChannelTarget | ThreadTarget]>([
    ["a channel after a 403", 403, MANAGED],
    ["a channel after a 404", 404, MANAGED],
    ["a thread after its lookup fails", 403, THREAD_TARGET],
  ])("makes no second attempt at %s", async (_label, status, target) => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 50001 }, { status })),
    );
    const run = client();

    const first = await failureOf(run.sendMessage(target, MESSAGE_BODY));
    const second = await failureOf(run.sendMessage(target, MESSAGE_BODY));

    expect(first.kind).toBe("channel_unavailable");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("goes on to other channels after one is unavailable", async () => {
    const other = fakeId(60);
    const managedBoth: ManagedChannelCheck = {
      isManaged: () => Promise.resolve(true),
    };
    fetchMock
      .mockResolvedValueOnce(Response.json({ code: 50001 }, { status: 403 }))
      .mockResolvedValueOnce(created());
    const run = client(managedBoth);

    await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
    await run.sendMessage(
      { kind: "channel", guildId: GUILD, channelId: other },
      MESSAGE_BODY,
    );

    expect(writes()[1]?.url).toContain(other);
  });
});

describe("what counts as an unavailable channel", () => {
  it.each([
    ["no code", 403, () => Response.json({}, { status: 403 })],
    [
      "another code",
      403,
      () => Response.json({ code: 40002 }, { status: 403 }),
    ],
    [
      "an HTML body",
      403,
      () => new Response("<html>blocked</html>", { status: 403 }),
    ],
  ])("does not mark a channel over %s", async (_label, status, answer) => {
    fetchMock.mockImplementation(() => Promise.resolve(answer()));
    const run = client();

    const failure = await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
    await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));

    expect(failure).toMatchObject({ kind: "api", status });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("rate limit scope", () => {
  function limited(
    headers: Record<string, string>,
    body: string | undefined = "{}",
  ) {
    return new Response(body, {
      status: 429,
      headers: { "retry-after": "1", ...headers },
    });
  }

  it.each<[string, () => Response]>([
    ["the scope header", () => limited({ "x-ratelimit-scope": "global" })],
    ["the global header", () => limited({ "x-ratelimit-global": "true" })],
    ["the body", () => limited({}, JSON.stringify({ global: true }))],
    ["a body that is not JSON", () => limited({}, "<html>banned</html>")],
  ])(
    "stops the run on a global limit known from %s",
    async (_label, answer) => {
      fetchMock.mockImplementation(() => Promise.resolve(answer()));

      const failure = await failureOf(
        client().sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure).toMatchObject({
        kind: "rate_limited",
        scope: "global",
        attempts: 1,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
      expect(actionForFailure(failure)).toBe("stop_run");
    },
  );

  it.each(["user", "shared"])(
    "reports and retries the scope %s, which the header decides",
    async (scope) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          limited(
            { "x-ratelimit-scope": scope },
            JSON.stringify({ global: true }),
          ),
        ),
      );

      const failure = await failureOf(
        client().sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure).toMatchObject({
        kind: "rate_limited",
        scope,
        attempts: 3,
      });
      expect(actionForFailure(failure)).toBe("retry_later");
    },
  );
});

describe("actionForFailure", () => {
  const limited = (scope: string | undefined): DiscordFailure => ({
    kind: "rate_limited",
    retryAfterMs: 1,
    attempts: 1,
    scope,
  });

  it.each<[DiscordFailure, string]>([
    [{ kind: "unauthorized" }, "stop_run"],
    [limited("global"), "stop_run"],
    [limited("user"), "retry_later"],
    [limited("shared"), "retry_later"],
    [limited(undefined), "retry_later"],
    [
      {
        kind: "channel_unavailable",
        channelId: MANAGED_FORUM,
        status: 403,
        code: 50001,
      },
      "mark_channel_unavailable",
    ],
    [{ kind: "check_failed", channelId: MANAGED_FORUM }, "retry_later"],
    [{ kind: "budget_exhausted" }, "retry_later"],
    [{ kind: "network" }, "retry_later"],
    [{ kind: "invalid_response", status: 200 }, "retry_later"],
    [{ kind: "api", status: 500, code: undefined }, "retry_later"],
    [{ kind: "api", status: 400, code: 50035 }, "skip_item"],
    [{ kind: "api", status: 400, code: 240000 }, "skip_item"],
    // A text code on another status, and refusals that do not blame the text.
    [{ kind: "api", status: 403, code: 200000 }, "retry_later"],
    [{ kind: "api", status: 400, code: undefined }, "retry_later"],
    [{ kind: "api", status: 400, code: 160005 }, "retry_later"],
    [{ kind: "api", status: 404, code: undefined }, "retry_later"],
    [{ kind: "invalid_target" }, "retry_later"],
    [{ kind: "unmanaged_target", channelId: MANAGED_FORUM }, "retry_later"],
    [{ kind: "not_forum", channelId: MANAGED_FORUM }, "retry_later"],
    [{ kind: "not_ephemeral" }, "retry_later"],
  ])("maps %j to %s", (failure, action) => {
    expect(actionForFailure(failure)).toBe(action);
  });
});

describe("guild scope", () => {
  const FOREIGN: ChannelTarget = {
    kind: "channel",
    guildId: OTHER_GUILD,
    channelId: MANAGED_FORUM,
  };
  const threadIn = (guildId: string | undefined) => ({
    channels: {
      [THREAD]: { type: 11, parent_id: MANAGED_FORUM, guild_id: guildId },
    },
  });

  it("passes the target's guild, or the signed one, to the check", async () => {
    serve();
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

    await client({ isManaged }).sendMessage(MANAGED, MESSAGE_BODY);
    await client({ isManaged }).replyToInteraction(IN_MANAGED, REPLY_BODY);

    expect(isManaged.mock.calls).toEqual([
      [GUILD, MANAGED_FORUM],
      [GUILD, MANAGED_FORUM],
    ]);
  });

  it.each<[string, Server, () => Promise<unknown>]>([
    [
      "a channel managed only in another guild",
      {},
      () => client().sendMessage(FOREIGN, MESSAGE_BODY),
    ],
    [
      "a thread Discord says is in another guild",
      threadIn(OTHER_GUILD),
      () => client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    ],
    [
      "a thread whose lookup names no guild",
      threadIn(undefined),
      () => client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    ],
    [
      "an interaction's thread in another guild, by lookup",
      threadIn(OTHER_GUILD),
      () =>
        client().replyToInteraction(
          interactionIn({ id: THREAD, type: 11 }),
          REPLY_BODY,
        ),
    ],
    [
      "a forum Discord says is in another guild",
      { channels: { [MANAGED_FORUM]: { type: 15, guild_id: OTHER_GUILD } } },
      () => client().createThread(MANAGED, THREAD_BODY),
    ],
  ])("refuses %s", async (_label, server, send) => {
    serve(server);

    expect((await failureOf(send())).kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses a malformed guild ID before the check", async () => {
    const isManaged = vi.fn<ManagedChannelCheck["isManaged"]>();

    const failure = await failureOf(
      client({ isManaged }).sendMessage(
        { kind: "channel", guildId: "../1", channelId: MANAGED_FORUM },
        MESSAGE_BODY,
      ),
    );

    expect(failure.kind).toBe("invalid_target");
    expect(isManaged).not.toHaveBeenCalled();
  });
});

describe("guild reads", () => {
  const ROLE_ROW = {
    id: fakeId(20),
    name: "Hostile @everyone",
    permissions: String(1n << 54n),
    position: 3,
    managed: false,
  };
  const CHANNEL_ROW = {
    id: fakeId(21),
    name: "events",
    type: 15,
    permission_overwrites: [{ id: GUILD, type: 0, allow: "0", deny: "1024" }],
  };

  function answer(body: unknown, status = 200) {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json(body, { status })),
    );
  }

  it("reads roles with the bot token, keeping permissions as a BigInt", async () => {
    answer([ROLE_ROW]);

    await expect(client().getGuildRoles(GUILD)).resolves.toEqual([
      { ...ROLE_ROW, permissions: 1n << 54n },
    ]);
    const [request] = requests();
    expect(request?.url).toBe(`${API}/guilds/${GUILD}/roles`);
    expect(request?.method).toBe("GET");
    expect(request?.headers.Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("reads channels and their overwrites", async () => {
    answer([CHANNEL_ROW]);

    await expect(client().getGuildChannels(GUILD)).resolves.toEqual([
      {
        id: CHANNEL_ROW.id,
        name: "events",
        type: 15,
        overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: 1024n }],
      },
    ]);
    expect(requests()[0]?.url).toBe(`${API}/guilds/${GUILD}/channels`);
  });

  it("reads one channel of the guild, with its overwrites", async () => {
    answer({ ...CHANNEL_ROW, guild_id: GUILD });

    await expect(
      client().getGuildChannel(GUILD, CHANNEL_ROW.id),
    ).resolves.toEqual({
      id: CHANNEL_ROW.id,
      name: "events",
      type: 15,
      overwrites: [{ id: GUILD, type: 0, allow: 0n, deny: 1024n }],
    });
    expect(requests()[0]?.url).toBe(`${API}/channels/${CHANNEL_ROW.id}`);
  });

  it("does not let a refused read stop sends to the channel", async () => {
    answer({ code: 50001 }, 403);
    const discord = client();

    expect(
      (await failureOf(discord.getGuildChannel(GUILD, MANAGED_FORUM))).kind,
    ).toBe("api");
    serve();
    await discord.sendMessage(MANAGED, MESSAGE_BODY);
    expect(writes()).toHaveLength(1);
  });

  it("reads a member's role IDs, and refuses ones that are not IDs", async () => {
    answer({ roles: [fakeId(20)] });

    await expect(
      client().getGuildMemberRoleIds(GUILD, APP_ID),
    ).resolves.toEqual([fakeId(20)]);
    expect(requests()[0]?.url).toBe(`${API}/guilds/${GUILD}/members/${APP_ID}`);

    answer({ roles: ["x"] });
    expect(
      await failureOf(client().getGuildMemberRoleIds(GUILD, APP_ID)),
    ).toEqual({ kind: "invalid_response", status: 200 });
  });

  const roles = (c: DiscordClient) => c.getGuildRoles(GUILD);
  const channels = (c: DiscordClient) => c.getGuildChannels(GUILD);
  const oneChannel = (c: DiscordClient) =>
    c.getGuildChannel(GUILD, CHANNEL_ROW.id);

  it.each<[string, (c: DiscordClient) => Promise<unknown>, unknown]>([
    ["roles that are not a list", roles, { id: fakeId(20) }],
    ["a bad permission string", roles, [{ ...ROLE_ROW, permissions: "" }]],
    ["a role with no ID", roles, [{ ...ROLE_ROW, id: "__proto__" }]],
    [
      "a bad overwrite",
      channels,
      [
        {
          ...CHANNEL_ROW,
          permission_overwrites: [
            { id: GUILD, type: 0, allow: "x", deny: "0" },
          ],
        },
      ],
    ],
    [
      "a channel type that is not a number",
      channels,
      [{ ...CHANNEL_ROW, type: "15" }],
    ],
    [
      "one channel in another guild",
      oneChannel,
      { ...CHANNEL_ROW, guild_id: OTHER_GUILD },
    ],
    ["one channel in no guild", oneChannel, CHANNEL_ROW],
    [
      "one channel with no overwrites",
      oneChannel,
      { ...CHANNEL_ROW, guild_id: GUILD, permission_overwrites: undefined },
    ],
  ])("refuses %s", async (_label, read, body) => {
    answer(body);

    expect(await failureOf(read(client()))).toEqual({
      kind: "invalid_response",
      status: 200,
    });
  });

  it.each(["../1", "", "constructor"])(
    "sends nothing for the malformed ID %j",
    async (id) => {
      const discord = client();

      for (const attempt of [
        discord.getGuildRoles(id),
        discord.getGuildChannels(id),
        discord.getGuildMemberRoleIds(GUILD, id),
        discord.getGuildChannel(GUILD, id),
      ]) {
        expect(await failureOf(attempt)).toEqual({ kind: "invalid_target" });
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("reports an error status without its body", async () => {
    answer({ code: 50001, message: "secret detail" }, 403);

    expect(await failureOf(client().getGuildRoles(GUILD))).toEqual({
      kind: "api",
      status: 403,
      code: 50001,
    });
  });
});

describe("channel reads", () => {
  it("reports what Discord says a thread is", async () => {
    serve({
      channels: {
        [THREAD]: {
          type: 11,
          parent_id: MANAGED_FORUM,
          owner_id: APP_ID,
          name: "A post",
        },
      },
    });

    await expect(client().describeChannel(THREAD)).resolves.toEqual({
      id: THREAD,
      type: 11,
      guildId: GUILD,
      parentId: MANAGED_FORUM,
      ownerId: APP_ID,
      name: "A post",
    });
  });

  it("sends nothing for a malformed channel ID", async () => {
    expect(await failureOf(client().describeChannel("../1"))).toEqual({
      kind: "invalid_target",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not ask again about a channel it was told it cannot use", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ code: DiscordErrorCode.UnknownChannel }, { status: 404 }),
    );
    const discord = client();

    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await failureOf(discord.describeChannel(THREAD))).kind).toBe(
        "channel_unavailable",
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  const REOPENED: ThreadTarget = {
    kind: "thread",
    guildId: GUILD,
    threadId: THREAD,
  };
  const threadUnder = (parentId: string) =>
    Response.json({
      id: THREAD,
      type: 11,
      guild_id: GUILD,
      parent_id: parentId,
    });

  it("reopens a managed thread, asking only to unarchive it", async () => {
    fetchMock.mockResolvedValueOnce(threadUnder(MANAGED_FORUM));
    fetchMock.mockResolvedValue(Response.json({ id: THREAD }));

    await client().reopenThread(REOPENED);

    const last = requests().at(-1);
    expect(last?.url).toBe(`${API}/channels/${THREAD}`);
    expect(last?.method).toBe("PATCH");
    expect(last?.body).toEqual({ archived: false });
  });

  it("does not reopen a thread outside a managed forum", async () => {
    fetchMock.mockResolvedValue(threadUnder(fakeId(99)));

    const failure = await failureOf(client().reopenThread(REOPENED));

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("can still use a thread after being refused its reopening", async () => {
    fetchMock.mockResolvedValueOnce(threadUnder(MANAGED_FORUM));
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: DiscordErrorCode.MissingPermissions },
        { status: 403 },
      ),
    );
    fetchMock.mockResolvedValue(threadUnder(MANAGED_FORUM));
    const discord = client();

    expect((await failureOf(discord.reopenThread(REOPENED))).kind).toBe("api");
    await expect(discord.describeChannel(THREAD)).resolves.toMatchObject({
      type: 11,
    });
  });
});

describe("messageUrl", () => {
  it("links to a message", () => {
    expect(messageUrl(GUILD, THREAD, MESSAGE)).toBe(
      `https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`,
    );
  });

  it.each([
    ["../1", THREAD, MESSAGE],
    [GUILD, "", MESSAGE],
    [GUILD, THREAD, "x"],
  ])("refuses malformed IDs: %j %j %j", (guild, channel, message) => {
    expect(() => messageUrl(guild, channel, message)).toThrow(RangeError);
  });
});

describe("getChannel", () => {
  const client = () =>
    createDiscordClient({
      check: { isManaged: () => Promise.reject(new Error("not expected")) },
      env: ENV,
      sleep,
    });

  it("reads a channel without asking the managed check", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: MANAGED_FORUM, type: 15, guild_id: GUILD }),
    );
    await expect(client().getChannel(GUILD, MANAGED_FORUM)).resolves.toEqual({
      type: 15,
      guildId: GUILD,
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/channels/${MANAGED_FORUM}`);
    expect(init?.method).toBe("GET");
  });

  it("makes no request for a malformed ID", async () => {
    await expect(client().getChannel("x", MANAGED_FORUM)).rejects.toMatchObject(
      { failure: { kind: "invalid_target" } },
    );
    await expect(client().getChannel(GUILD, "x")).rejects.toMatchObject({
      failure: { kind: "invalid_target" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("remembers an unknown channel and does not ask twice", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ code: 10003 }, { status: 404 }),
    );
    const discord = client();
    const expected = {
      failure: { kind: "channel_unavailable", code: 10003 },
    };
    await expect(
      discord.getChannel(GUILD, MANAGED_FORUM),
    ).rejects.toMatchObject(expected);
    await expect(
      discord.getChannel(GUILD, MANAGED_FORUM),
    ).rejects.toMatchObject(expected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
