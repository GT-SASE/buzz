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

  it("replies to an interaction without sending the bot token", async () => {
    serve({ send: () => new Response(null, { status: 204 }) });

    await client().replyToInteraction(IN_MANAGED, REPLY_BODY);

    const [request] = writes();
    expect(request?.url).toBe(
      `${API}/interactions/${INTERACTION}/${ENCODED_TOKEN}/callback`,
    );
    expect(request?.headers.Authorization).toBeUndefined();
  });

  it("edits the original interaction reply without the bot token", async () => {
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
  it.each([15, 16])("posts in a managed channel of type %i", async (type) => {
    serve({ channels: { [MANAGED_FORUM]: { type } } });

    const thread = await client().createThread(MANAGED, THREAD_BODY);

    expect(thread.id).toBe(CREATED_ID);
    expect(writes()[0]?.url).toBe(`${API}/channels/${MANAGED_FORUM}/threads`);
  });

  it("returns the first message of the new post", async () => {
    const firstMessage = fakeId(101);
    serve({
      channels: { [MANAGED_FORUM]: { type: 15 } },
      send: () =>
        Response.json({ id: CREATED_ID, message: { id: firstMessage } }),
    });

    await expect(client().createThread(MANAGED, THREAD_BODY)).resolves.toEqual({
      id: CREATED_ID,
      firstMessageId: firstMessage,
    });
  });

  it("counts the post's own ID as its first message if Discord leaves it out", async () => {
    serve({ channels: { [MANAGED_FORUM]: { type: 15 } } });

    const post = await client().createThread(MANAGED, THREAD_BODY);

    expect(post.firstMessageId).toBe(CREATED_ID);
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

  it("refuses when the channel lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 50001 }, { status: 403 }),
    );

    const failure = await failureOf(
      client().createThread(MANAGED, THREAD_BODY),
    );

    expect(failure).toEqual({
      kind: "channel_unavailable",
      channelId: MANAGED_FORUM,
      status: 403,
      code: 50001,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("refuses a target that is not a channel", async () => {
    // @ts-expect-error Only a channel can be the parent of a new thread.
    const attempt = client().createThread(THREAD_TARGET, THREAD_BODY);

    expect((await failureOf(attempt)).kind).toBe("invalid_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses another kind of target even with a valid channel ID", async () => {
    const target = { kind: "thread", guildId: GUILD, channelId: MANAGED_FORUM };

    const attempt = client().createThread(
      target as unknown as ChannelTarget,
      THREAD_BODY,
    );

    expect((await failureOf(attempt)).kind).toBe("invalid_target");
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

  it("does not accept parentId in the type of a target", () => {
    const target: ThreadTarget = {
      kind: "thread",
      guildId: GUILD,
      threadId: THREAD,
      // @ts-expect-error The parent must come from Discord, not the caller.
      parentId: MANAGED_FORUM,
    };

    expect(target.threadId).toBe(THREAD);
  });

  it("refuses a thread whose real parent is unmanaged", async () => {
    serve({
      channels: { [THREAD]: { type: 11, parent_id: UNMANAGED_CHANNEL } },
    });

    const failure = await failureOf(
      client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "unmanaged_target", channelId: THREAD });
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

  it.each([undefined, null, "1", "../1", 5])(
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
      "a refusal with a code",
      () => Response.json({ code: 10003 }, { status: 404 }),
      {
        kind: "channel_unavailable",
        channelId: THREAD,
        status: 404,
        code: 10003,
      },
    ],
    [
      "missing access",
      () => Response.json({ code: 50001 }, { status: 403 }),
      {
        kind: "channel_unavailable",
        channelId: THREAD,
        status: 403,
        code: 50001,
      },
    ],
    [
      "a malformed answer",
      () => Response.json({}),
      { kind: "invalid_response", status: 200 },
    ],
  ])(
    "refuses the send when the lookup gets %s",
    async (_l, answer, failure) => {
      fetchMock.mockImplementationOnce(() => Promise.resolve(answer()));

      expect(
        await failureOf(client().sendMessage(THREAD_TARGET, MESSAGE_BODY)),
      ).toEqual(failure);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("refuses the send when the lookup has no response", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const failure = await failureOf(
      client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "network" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

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

    it("refuses when that lookup fails", async () => {
      fetchMock.mockResolvedValueOnce(
        Response.json({ code: 50001 }, { status: 403 }),
      );

      const failure = await failureOf(
        send(interactionIn({ id: THREAD, type: 11 })),
      );

      expect(failure).toEqual({
        kind: "channel_unavailable",
        channelId: THREAD,
        status: 403,
        code: 50001,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it("applies the type rule to the lookup as well", async () => {
      serve({
        channels: { [THREAD]: { type: 0, parent_id: MANAGED_FORUM } },
      });

      const failure = await failureOf(
        send(interactionIn({ id: THREAD, type: 11 })),
      );

      expect(failure.kind).toBe("unmanaged_target");
      expect(writes()).toEqual([]);
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

  it("does not accept a plain target in the types", async () => {
    const attempt = client().replyToInteraction(
      // @ts-expect-error Only a verified interaction names where a reply lands.
      { interactionId: INTERACTION, token: "x", target: MANAGED },
      REPLY_BODY,
    );

    expect((await failureOf(attempt)).kind).toBe("invalid_target");
    expect(fetchMock).not.toHaveBeenCalled();
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
  ])("refuses %s, even in a managed channel", async (_label, body) => {
    expect(
      await failureOf(client().respondEphemerally(IN_MANAGED, body as never)),
    ).toEqual({ kind: "not_ephemeral" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a response that is direct but not ephemeral", async () => {
    expect(
      await failureOf(client().respondEphemerally(IN_UNMANAGED, pong())),
    ).toEqual({ kind: "not_ephemeral" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a public reply to an unmanaged channel through the checked path", async () => {
    expect(
      (await failureOf(client().replyToInteraction(IN_UNMANAGED, REPLY_BODY)))
        .kind,
    ).toBe("unmanaged_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a public defer and its edit checked", async () => {
    expect(
      (
        await failureOf(
          client().replyToInteraction(IN_UNMANAGED, deferredReply()),
        )
      ).kind,
    ).toBe("unmanaged_target");
    expect(
      (await failureOf(client().editInteractionReply(IN_UNMANAGED, EDIT_BODY)))
        .kind,
    ).toBe("unmanaged_target");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a message update only through the checked path", async () => {
    const body = updateMessage({ content: safe`hi`, mentionUserIds: [] });
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

    const failure = await failureOf(
      client({ isManaged }).replyToInteraction(IN_UNMANAGED, body),
    );

    expect(failure.kind).toBe("unmanaged_target");
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

  it.each([
    [1, [250]],
    [2, [250, 500]],
    [3, [250, 500, 1000]],
  ])(
    "waits and reads again when the reply is missing %i time(s)",
    async (misses, waits) => {
      originalAppearsAfter(misses);

      const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(waits);
      expect(writes()).toHaveLength(1);
    },
  );

  it("gives up after the last wait, and writes nothing", async () => {
    originalAppearsAfter(4);

    expect(
      await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
    ).toMatchObject({ kind: "api", status: 404 });
    expect(requests()).toHaveLength(4);
    expect(writes()).toEqual([]);
  });

  it("does not wait past its budget", async () => {
    originalAppearsAfter(4);

    expect(
      await failureOf(
        client(check, {
          budget: { operationMs: 100 },
        }).editEphemeralReply(IN_UNMANAGED, EDIT_BODY),
      ),
    ).toMatchObject({ kind: "api", status: 404 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry other failures", async () => {
    serve({ original: () => Response.json({ code: 1 }, { status: 403 }) });

    await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY));

    expect(sleep).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(1);
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
    ],
    [
      "not JSON",
      () => new Response("<html>", { status: 200 }),
      { kind: "not_ephemeral" },
    ],
  ])("refuses when the GET is %s", async (_label, original, failure) => {
    serve({ original });

    expect(
      await failureOf(client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY)),
    ).toEqual(failure);
    expect(writes()).toEqual([]);
  });

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

    it.each(FAULTS)("reads again after two reads fail: %s", async (how) => {
      faultyServer(how, { gets: 2 });

      const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
      expect(writes()).toHaveLength(1);
    });

    it.each(FAULTS)("edits again after two edits fail: %s", async (how) => {
      faultyServer(how, { patches: 2 });

      const edited = await client().editEphemeralReply(IN_UNMANAGED, EDIT_BODY);

      expect(edited.id).toBe(CREATED_ID);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500]);
      const [first, ...others] = writes();
      expect(others).toHaveLength(2);
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

    it("does not wait past its budget", async () => {
      faultyServer("503", { gets: 4 });

      expect(
        await failureOf(
          client(check, {
            budget: { operationMs: 100 },
          }).editEphemeralReply(IN_UNMANAGED, EDIT_BODY),
        ),
      ).toMatchObject({ kind: "api", status: 503 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
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

    it.each(FAULTS)(
      "repeats a checked edit of the reply too: %s",
      async (how) => {
        faultyServer(how, { patches: 2 });

        const edited = await client().editInteractionReply(
          IN_MANAGED,
          EDIT_BODY,
        );

        expect(edited.id).toBe(CREATED_ID);
        expect(writes()).toHaveLength(3);
      },
    );

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
  it("waits for retry-after and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(tooMany("1.5"))
      .mockResolvedValueOnce(created());

    const sent = await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(sent.id).toBe(CREATED_ID);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[1500]]);
    expect(requests()[1]?.body).toEqual(requests()[0]?.body);
  });

  it("falls back to retry_after in the body", async () => {
    fetchMock
      .mockResolvedValueOnce(tooMany(undefined, { retry_after: 0.25 }))
      .mockResolvedValueOnce(created());

    await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(sleep.mock.calls).toEqual([[250]]);
  });

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

  it("gives up on a callback without sleeping when the wait does not fit", async () => {
    const { options } = clocked();
    fetchMock.mockImplementationOnce(() => Promise.resolve(tooMany("2.5")));

    const failure = await failureOf(
      client(check, options).replyToInteraction(IN_MANAGED, REPLY_BODY),
    );

    expect(failure).toEqual({
      kind: "rate_limited",
      retryAfterMs: 2500,
      attempts: 1,
      scope: undefined,
    });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a callback when the wait fits", async () => {
    const { options } = clocked();
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(tooMany("2.499")))
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      );

    await client(check, options).replyToInteraction(IN_MANAGED, REPLY_BODY);

    expect(sleep.mock.calls).toEqual([[2499]]);
  });

  it("applies the callback budget to ephemeral responses", async () => {
    const { options } = clocked();
    fetchMock.mockImplementationOnce(() => Promise.resolve(tooMany("3")));

    const failure = await failureOf(
      client(check, options).respondEphemerally(IN_MANAGED, EPHEMERAL_BODY),
    );

    expect(failure.kind).toBe("rate_limited");
    expect(sleep).not.toHaveBeenCalled();
  });

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

  it("can be configured", async () => {
    const { options } = clocked({ budget: { operationMs: 1000 } });
    fetchMock.mockImplementationOnce(() => Promise.resolve(tooMany("1")));

    const failure = await failureOf(
      client(check, options).sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("rate_limited");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("limits each attempt to what remains", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { options } = clocked();
    fetchMock
      .mockImplementationOnce(() => Promise.resolve(tooMany("1")))
      .mockImplementationOnce(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      );

    await client(check, options).replyToInteraction(IN_MANAGED, REPLY_BODY);

    expect(timeout.mock.calls).toEqual([[2500], [1500]]);
  });

  it("never gives an attempt more than the request timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    fetchMock.mockImplementationOnce(() => Promise.resolve(created()));

    await client(check, {
      ...clocked().options,
      budget: { operationMs: 60_000 },
    }).sendMessage(MANAGED, MESSAGE_BODY);

    expect(timeout.mock.calls).toEqual([[10_000]]);
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

  it("ignores a check that answers after the budget", async () => {
    let answer: (managed: boolean) => void = () => undefined;
    const late: ManagedChannelCheck = {
      isManaged: () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    };

    const failure = await failureOf(
      client(late, { budget: { operationMs: 5 } }).sendMessage(
        MANAGED,
        MESSAGE_BODY,
      ),
    );
    answer(true);
    await Promise.resolve();

    expect(failure.kind).toBe("check_failed");
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

  it("does not blame the channel for an unknown message", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 10008 }, { status: 404 }),
    );

    const failure = await failureOf(
      client().editMessage(MANAGED, MESSAGE, EDIT_BODY),
    );

    expect(failure).toEqual({ kind: "api", status: 404, code: 10008 });
  });

  it("reports other refusals with their code", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: 50035 }, { status: 400 }),
    );

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "api", status: 400, code: 50035 });
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

  it("reports an error response that holds no JSON", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("<html>bad gateway</html>", { status: 502 }),
    );

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "api", status: 502, code: undefined });
  });

  it("reports a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "network" });
  });

  it("reports a success response without an ID", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({}, { status: 200 }));

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toEqual({ kind: "invalid_response", status: 200 });
  });
});

describe("secrets", () => {
  const leaky = `${TOKEN} ${INTERACTION_TOKEN} ${SECRET_TEXT}`;
  const refuses: ManagedChannelCheck = {
    isManaged: () => Promise.resolve(false),
  };
  const failsLoudly: ManagedChannelCheck = {
    isManaged: () => Promise.reject(new Error(leaky)),
  };

  const cases: readonly (readonly [
    string,
    () => unknown,
    ManagedChannelCheck,
  ])[] = [
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
      "an API error with no JSON",
      () =>
        fetchMock.mockImplementation(() =>
          Promise.resolve(new Response(leaky, { status: 500 })),
        ),
      check,
    ],
    [
      "a network error that quotes them",
      () => fetchMock.mockRejectedValue(new Error(leaky, { cause: leaky })),
      check,
    ],
    [
      "exhausted rate limit retries",
      () =>
        fetchMock.mockImplementation(() =>
          Promise.resolve(tooMany("1", { message: leaky })),
        ),
      check,
    ],
    ["a check that fails and quotes them", () => undefined, failsLoudly],
    [
      "a refused target",
      () => {
        serve();
      },
      refuses,
    ],
    [
      "a malformed success response",
      () =>
        fetchMock.mockImplementation(() =>
          Promise.resolve(new Response(leaky, { status: 200 })),
        ),
      check,
    ],
  ];

  it.each(cases)(
    "stay out of the error for %s",
    async (_label, arrange, managedCheck) => {
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
    },
  );

  it("stay out of the error for a refused ephemeral edit", async () => {
    serve({ original: () => Response.json({ id: MESSAGE, content: leaky }) });

    const error: unknown = await client()
      .editEphemeralReply(IN_UNMANAGED, EDIT_BODY)
      .catch((reason: unknown) => reason);

    const text = inspect(error, { depth: null, showHidden: true });
    expect(error).toBeInstanceOf(DiscordClientError);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ENCODED_TOKEN);
    expect(text).not.toContain(SECRET_TEXT);
  });

  it("cannot be read from the client object", () => {
    const instance = client();

    const text = `${JSON.stringify(instance)}${inspect(instance, { depth: null, showHidden: true })}`;

    expect(text).not.toContain(TOKEN);
  });

  it("never reach the console", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    fetchMock
      .mockResolvedValueOnce(tooMany("1"))
      .mockResolvedValueOnce(created())
      .mockRejectedValueOnce(new Error(leaky));

    await client().sendMessage(MANAGED, MESSAGE_BODY);
    await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY));

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

  it.each([403, 404])(
    "makes no second attempt at a channel after a %i",
    async (status) => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(Response.json({ code: 50001 }, { status })),
      );
      const run = client();

      const first = await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));
      const second = await failureOf(run.sendMessage(MANAGED, MESSAGE_BODY));

      expect(first.kind).toBe("channel_unavailable");
      expect(second).toEqual(first);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("makes no second attempt at a thread after its lookup fails", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ code: 50001 }, { status: 403 })),
    );
    const run = client();

    await failureOf(run.sendMessage(THREAD_TARGET, MESSAGE_BODY));
    await failureOf(run.sendMessage(THREAD_TARGET, MESSAGE_BODY));

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

  it("starts fresh with a new client", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ code: 50001 }, { status: 403 }))
      .mockResolvedValueOnce(created());

    await failureOf(client().sendMessage(MANAGED, MESSAGE_BODY));
    await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("what counts as an unavailable channel", () => {
  it.each([
    ["no code", 403, () => Response.json({}, { status: 403 })],
    ["no code on a 404", 404, () => Response.json({}, { status: 404 })],
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
    [
      "an HTML 404",
      404,
      () => new Response("<html>missing</html>", { status: 404 }),
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
    ["an empty body", () => limited({}, "")],
  ])("does not retry a global limit known from %s", async (_label, answer) => {
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
  });

  it("lets the scope header win over the rest", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        limited(
          { "x-ratelimit-scope": "shared" },
          JSON.stringify({ global: true }),
        ),
      ),
    );

    const failure = await failureOf(
      client().sendMessage(MANAGED, MESSAGE_BODY),
    );

    expect(failure).toMatchObject({ scope: "shared", attempts: 3 });
  });

  it("still retries a limit with no scope", async () => {
    fetchMock
      .mockResolvedValueOnce(limited({}))
      .mockResolvedValueOnce(created());

    await client().sendMessage(MANAGED, MESSAGE_BODY);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["user", "global", "shared"])(
    "reports the scope %s",
    async (scope) => {
      fetchMock.mockResolvedValueOnce(
        Response.json(
          {},
          {
            status: 429,
            headers: { "retry-after": "60", "x-ratelimit-scope": scope },
          },
        ),
      );

      const failure = await failureOf(
        client().sendMessage(MANAGED, MESSAGE_BODY),
      );

      expect(failure).toMatchObject({ kind: "rate_limited", scope });
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
    [{ kind: "api", status: 400, code: 200000 }, "skip_item"],
    [{ kind: "api", status: 400, code: 240000 }, "skip_item"],
    // A text code on another status, and refusals that do not blame the text.
    [{ kind: "api", status: 403, code: 200000 }, "retry_later"],
    [{ kind: "api", status: 400, code: undefined }, "retry_later"],
    [{ kind: "api", status: 400, code: 160005 }, "retry_later"],
    [{ kind: "api", status: 403, code: 160005 }, "retry_later"],
    [{ kind: "api", status: 403, code: 40333 }, "retry_later"],
    [{ kind: "api", status: 404, code: undefined }, "retry_later"],
    [{ kind: "api", status: 408, code: undefined }, "retry_later"],
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

  it("passes the target's guild to the check", async () => {
    serve();
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

    await client({ isManaged }).sendMessage(MANAGED, MESSAGE_BODY);

    expect(isManaged).toHaveBeenCalledWith(GUILD, MANAGED_FORUM);
  });

  it("passes the signed guild to the check for an interaction", async () => {
    serve();
    const isManaged = vi.fn((guildId: string, channelId: string) =>
      check.isManaged(guildId, channelId),
    );

    await client({ isManaged }).replyToInteraction(IN_MANAGED, REPLY_BODY);

    expect(isManaged).toHaveBeenCalledWith(GUILD, MANAGED_FORUM);
  });

  it("refuses a channel managed only in another guild", async () => {
    serve();

    const failure = await failureOf(
      client().sendMessage(FOREIGN, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses a thread Discord says is in another guild", async () => {
    serve({
      channels: {
        [THREAD]: {
          type: 11,
          parent_id: MANAGED_FORUM,
          guild_id: OTHER_GUILD,
        },
      },
    });

    const failure = await failureOf(
      client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses a thread whose lookup names no guild", async () => {
    serve({
      channels: {
        [THREAD]: { type: 11, parent_id: MANAGED_FORUM, guild_id: undefined },
      },
    });

    const failure = await failureOf(
      client().sendMessage(THREAD_TARGET, MESSAGE_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses an interaction's thread in another guild, by lookup", async () => {
    serve({
      channels: {
        [THREAD]: {
          type: 11,
          parent_id: MANAGED_FORUM,
          guild_id: OTHER_GUILD,
        },
      },
    });

    const failure = await failureOf(
      client().replyToInteraction(
        interactionIn({ id: THREAD, type: 11 }),
        REPLY_BODY,
      ),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(writes()).toEqual([]);
  });

  it("refuses a forum Discord says is in another guild", async () => {
    serve({
      channels: { [MANAGED_FORUM]: { type: 15, guild_id: OTHER_GUILD } },
    });

    const failure = await failureOf(
      client().createThread(MANAGED, THREAD_BODY),
    );

    expect(failure.kind).toBe("unmanaged_target");
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

  it.each([
    ["in another guild", { ...CHANNEL_ROW, guild_id: OTHER_GUILD }],
    ["in no guild", CHANNEL_ROW],
    [
      "with no overwrites",
      { ...CHANNEL_ROW, guild_id: GUILD, permission_overwrites: undefined },
    ],
  ])("refuses one channel %s", async (_label, body) => {
    answer(body);

    expect(
      await failureOf(client().getGuildChannel(GUILD, CHANNEL_ROW.id)),
    ).toEqual({ kind: "invalid_response", status: 200 });
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

  it("refuses a malformed channel ID before any request", async () => {
    expect(await failureOf(client().getGuildChannel(GUILD, "../1"))).toEqual({
      kind: "invalid_target",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a member's role IDs", async () => {
    answer({ roles: [fakeId(20)] });

    await expect(
      client().getGuildMemberRoleIds(GUILD, APP_ID),
    ).resolves.toEqual([fakeId(20)]);
    expect(requests()[0]?.url).toBe(`${API}/guilds/${GUILD}/members/${APP_ID}`);
  });

  it.each([
    ["not a list", { id: fakeId(20) }],
    ["a bad permission string", [{ ...ROLE_ROW, permissions: "" }]],
    ["a numeric permission", [{ ...ROLE_ROW, permissions: 8 }]],
    ["a role with no ID", [{ ...ROLE_ROW, id: "__proto__" }]],
    ["a name that is not text", [{ ...ROLE_ROW, name: 1 }]],
    ["no position", [{ ...ROLE_ROW, position: "1" }]],
    ["managed that is not a boolean", [{ ...ROLE_ROW, managed: "no" }]],
  ])("refuses roles with %s", async (_label, body) => {
    answer(body);

    expect(await failureOf(client().getGuildRoles(GUILD))).toEqual({
      kind: "invalid_response",
      status: 200,
    });
  });

  it.each([
    ["no overwrites", [{ ...CHANNEL_ROW, permission_overwrites: undefined }]],
    [
      "a bad overwrite",
      [
        {
          ...CHANNEL_ROW,
          permission_overwrites: [
            { id: GUILD, type: 0, allow: "x", deny: "0" },
          ],
        },
      ],
    ],
    ["a type that is not a number", [{ ...CHANNEL_ROW, type: "15" }]],
    ["no name", [{ ...CHANNEL_ROW, name: undefined }]],
  ])("refuses channels with %s", async (_label, body) => {
    answer(body);

    expect(await failureOf(client().getGuildChannels(GUILD))).toEqual({
      kind: "invalid_response",
      status: 200,
    });
  });

  it("refuses a member whose roles are not IDs", async () => {
    answer({ roles: ["x"] });

    expect(
      await failureOf(client().getGuildMemberRoleIds(GUILD, APP_ID)),
    ).toEqual({ kind: "invalid_response", status: 200 });
  });

  it.each(["../1", "", "constructor"])(
    "sends nothing for the malformed ID %j",
    async (id) => {
      const discord = client();

      for (const attempt of [
        discord.getGuildRoles(id),
        discord.getGuildChannels(id),
        discord.getGuildMemberRoleIds(GUILD, id),
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

  it("leaves out fields that are absent or malformed", async () => {
    serve({ channels: { [THREAD]: { parent_id: "../1", name: 5 } } });

    await expect(client().describeChannel(THREAD)).resolves.toEqual({
      id: THREAD,
      type: 0,
      guildId: GUILD,
      parentId: undefined,
      ownerId: undefined,
      name: undefined,
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

  it("lists active threads with the fields it can read", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        threads: [
          { id: THREAD, parent_id: MANAGED_FORUM, owner_id: APP_ID, name: "A" },
          { id: fakeId(21), name: "B" },
        ],
      }),
    );

    await expect(client().listActiveThreads(GUILD)).resolves.toEqual([
      { id: THREAD, parentId: MANAGED_FORUM, ownerId: APP_ID, name: "A" },
      { id: fakeId(21), parentId: undefined, ownerId: undefined, name: "B" },
    ]);
    expect(requests()[0]?.url).toBe(`${API}/guilds/${GUILD}/threads/active`);
  });

  it("reopens a managed thread, asking only to unarchive it", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: THREAD,
        type: 11,
        guild_id: GUILD,
        parent_id: MANAGED_FORUM,
      }),
    );
    fetchMock.mockResolvedValue(Response.json({ id: THREAD }));

    await client().reopenThread({
      kind: "thread",
      guildId: GUILD,
      threadId: THREAD,
    });

    const last = requests().at(-1);
    expect(last?.url).toBe(`${API}/channels/${THREAD}`);
    expect(last?.method).toBe("PATCH");
    expect(last?.body).toEqual({ archived: false });
  });

  it("does not reopen a thread outside a managed forum", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        id: THREAD,
        type: 11,
        guild_id: GUILD,
        parent_id: fakeId(99),
      }),
    );

    const failure = await failureOf(
      client().reopenThread({
        kind: "thread",
        guildId: GUILD,
        threadId: THREAD,
      }),
    );

    expect(failure.kind).toBe("unmanaged_target");
    expect(requests().filter((request) => request.method === "PATCH")).toEqual(
      [],
    );
  });

  it("can still use a thread after being refused its reopening", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        id: THREAD,
        type: 11,
        guild_id: GUILD,
        parent_id: MANAGED_FORUM,
      }),
    );
    fetchMock.mockResolvedValueOnce(
      Response.json(
        { code: DiscordErrorCode.MissingPermissions },
        { status: 403 },
      ),
    );
    fetchMock.mockResolvedValue(
      Response.json({
        id: THREAD,
        type: 11,
        guild_id: GUILD,
        parent_id: MANAGED_FORUM,
      }),
    );
    const discord = client();

    expect(
      (
        await failureOf(
          discord.reopenThread({
            kind: "thread",
            guildId: GUILD,
            threadId: THREAD,
          }),
        )
      ).kind,
    ).toBe("api");
    await expect(discord.describeChannel(THREAD)).resolves.toMatchObject({
      type: 11,
    });
  });

  it("reads a page of a forum's archived threads", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        threads: [{ id: THREAD, parent_id: MANAGED_FORUM, name: "A" }],
      }),
    );

    await expect(client().listArchivedThreads(MANAGED_FORUM)).resolves.toEqual([
      { id: THREAD, parentId: MANAGED_FORUM, ownerId: undefined, name: "A" },
    ]);
    expect(requests()[0]?.url).toBe(
      `${API}/channels/${MANAGED_FORUM}/threads/archived/public?limit=100`,
    );
  });

  it("can still use a forum after being refused its archived threads", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ code: DiscordErrorCode.MissingAccess }, { status: 403 }),
    );
    fetchMock.mockResolvedValue(Response.json({ id: MANAGED_FORUM, type: 15 }));
    const discord = client();

    expect(await failureOf(discord.listArchivedThreads(MANAGED_FORUM))).toEqual(
      {
        kind: "api",
        status: 403,
        code: DiscordErrorCode.MissingAccess,
      },
    );
    await expect(discord.describeChannel(MANAGED_FORUM)).resolves.toMatchObject(
      { type: 15 },
    );
  });

  it("sends nothing for a malformed forum ID", async () => {
    expect(await failureOf(client().listArchivedThreads("../1"))).toEqual({
      kind: "invalid_target",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["not a list", { threads: "x" }],
    ["a thread with no ID", { threads: [{ name: "A" }] }],
    ["a thread with no name", { threads: [{ id: fakeId(21) }] }],
  ])("refuses %s rather than give half an answer", async (_label, body) => {
    fetchMock.mockResolvedValue(Response.json(body));

    expect(await failureOf(client().listActiveThreads(GUILD))).toEqual({
      kind: "invalid_response",
      status: 200,
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

  it("reports a channel with no guild as having none", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ type: 15 }));
    await expect(client().getChannel(GUILD, MANAGED_FORUM)).resolves.toEqual({
      type: 15,
      guildId: undefined,
    });
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
