// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { generateKeyPairSync, sign } from "node:crypto";
import {
  ApplicationCommandType,
  InteractionContextType,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
} from "discord-api-types/v10";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../api/interactions.ts";

const waitUntil = vi.hoisted(() => vi.fn());
vi.mock("@vercel/functions", () => ({ waitUntil }));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

const ALLOWED_GUILD = "1".repeat(18);
const OTHER_GUILD = "2".repeat(18);
const APP_ID = "4".repeat(18);
const OTHER_APP_ID = "5".repeat(18);
const INTERACTION_TOKEN = "interaction-token-that-must-not-be-logged";
const MAX_BODY_BYTES = 64 * 1024;
const WELL_FORMED_SIGNATURE = "ab".repeat(64);

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function signatureFor(timestamp: string, body: Uint8Array): string {
  return sign(
    null,
    Buffer.concat([Buffer.from(timestamp), body]),
    privateKey,
  ).toString("hex");
}

function requestWith(
  body: Uint8Array,
  headers: Record<string, string>,
): Request {
  return new Request("https://bot.example.test/api/interactions", {
    method: "POST",
    headers,
    body: Buffer.from(body),
  });
}

function signedBytes(body: Uint8Array, timestamp = nowSeconds()): Request {
  return requestWith(body, {
    "x-signature-ed25519": signatureFor(timestamp, body),
    "x-signature-timestamp": timestamp,
  });
}

function signedRequest(payload: unknown, timestamp = nowSeconds()): Request {
  return signedBytes(Buffer.from(JSON.stringify(payload)), timestamp);
}

function badlySignedRequest(payload: unknown): Request {
  return requestWith(Buffer.from(JSON.stringify(payload)), {
    "x-signature-ed25519": WELL_FORMED_SIGNATURE,
    "x-signature-timestamp": nowSeconds(),
  });
}

/** A request that records how many times its body was pulled from. */
function streamedRequest(
  chunkCount: number,
  chunkBytes: number,
  headers: Record<string, string>,
) {
  let pulls = 0;
  const request = new Request("https://bot.example.test/api/interactions", {
    method: "POST",
    headers,
    duplex: "half",
    body: new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls > chunkCount) {
            controller.close();
          } else {
            controller.enqueue(new Uint8Array(chunkBytes));
          }
        },
      },
      { highWaterMark: 0 },
    ),
  });
  return { request, pulls: () => pulls };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    type: InteractionType.ApplicationCommand,
    id: "6".repeat(18),
    token: INTERACTION_TOKEN,
    channel: { id: "7".repeat(18), type: 0 },
    application_id: APP_ID,
    guild_id: ALLOWED_GUILD,
    context: InteractionContextType.Guild,
    authorizing_integration_owners: { "0": ALLOWED_GUILD },
    member: { user: { id: "3".repeat(18) }, roles: [], permissions: "0" },
    data: { type: ApplicationCommandType.ChatInput, name: "ping" },
    ...overrides,
  };
}

const ping = { type: InteractionType.Ping };

const FIXED_REFUSAL = {
  type: InteractionResponseType.ChannelMessageWithSource,
  data: {
    content: "You can't do that, or it doesn't exist.",
    flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
    allowed_mentions: { parse: [], users: [] },
  },
};

beforeEach(() => {
  vi.stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
  vi.stubEnv("DISCORD_APP_ID", APP_ID);
  vi.stubEnv("ALLOWED_GUILD_IDS", ALLOWED_GUILD);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("signature checks", () => {
  it("accepts a valid signature", async () => {
    const response = await POST(signedRequest(ping));
    expect(response.status).toBe(200);
  });

  it("refuses a bad signature", async () => {
    const response = await POST(badlySignedRequest(ping));
    expect(response.status).toBe(401);
  });

  it("accepts a valid signature spelled in uppercase", async () => {
    const body = Buffer.from(JSON.stringify(ping));
    const timestamp = nowSeconds();
    const response = await POST(
      requestWith(body, {
        "x-signature-ed25519": signatureFor(timestamp, body).toUpperCase(),
        "x-signature-timestamp": timestamp,
      }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a bad signature spelled in uppercase", async () => {
    const response = await POST(
      requestWith(Buffer.from(JSON.stringify(ping)), {
        "x-signature-ed25519": "AB".repeat(64),
        "x-signature-timestamp": nowSeconds(),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a good signature followed by letters that are not hex", async () => {
    const body = Buffer.from(JSON.stringify(ping));
    const timestamp = nowSeconds();
    const response = await POST(
      requestWith(body, {
        "x-signature-ed25519": `${signatureFor(timestamp, body)}zz`,
        "x-signature-timestamp": timestamp,
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a tampered body", async () => {
    const timestamp = nowSeconds();
    const signature = signatureFor(
      timestamp,
      Buffer.from(JSON.stringify(command({ guild_id: OTHER_GUILD }))),
    );
    const response = await POST(
      requestWith(Buffer.from(JSON.stringify(command())), {
        "x-signature-ed25519": signature,
        "x-signature-timestamp": timestamp,
      }),
    );
    expect(response.status).toBe(401);
  });

  it.each(["x-signature-ed25519", "x-signature-timestamp"])(
    "refuses a request without %s",
    async (missing) => {
      const request = signedRequest(ping);
      request.headers.delete(missing);

      const response = await POST(request);
      expect(response.status).toBe(401);
    },
  );

  it("refuses a correctly signed timestamp older than 5 minutes", async () => {
    const stale = String(Number(nowSeconds()) - 301);
    const response = await POST(signedRequest(ping, stale));
    expect(response.status).toBe(401);
  });

  it("refuses a correctly signed timestamp over 5 minutes ahead", async () => {
    const ahead = String(Number(nowSeconds()) + 301);
    const response = await POST(signedRequest(ping, ahead));
    expect(response.status).toBe(401);
  });

  it("refuses a bad signature before looking at the other settings", async () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", undefined);
    vi.stubEnv("DISCORD_APP_ID", undefined);
    const response = await POST(badlySignedRequest(command()));
    expect(response.status).toBe(401);
  });
});

describe("timestamp and body boundary", () => {
  // The signed message is the two parts joined, so moving bytes across the
  // boundary leaves the signature valid. Other checks have to catch it.
  const sent = Buffer.from(JSON.stringify(ping));

  it("refuses a digit moved from the timestamp into the body", async () => {
    const timestamp = nowSeconds();
    const response = await POST(
      requestWith(Buffer.concat([Buffer.from(timestamp.slice(-1)), sent]), {
        "x-signature-ed25519": signatureFor(timestamp, sent),
        "x-signature-timestamp": timestamp.slice(0, -1),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("refuses a byte moved from the body into the timestamp", async () => {
    const timestamp = nowSeconds();
    const response = await POST(
      requestWith(sent.subarray(1), {
        "x-signature-ed25519": signatureFor(timestamp, sent),
        "x-signature-timestamp": `${timestamp}${sent.subarray(0, 1).toString()}`,
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("exact raw bytes", () => {
  it("verifies unusual spacing, key order and escapes as sent", async () => {
    const response = await POST(
      signedBytes(Buffer.from('{ "a":"\\u00e9é" ,\n\t"type" : 1 }')),
    );
    expect(response.status).toBe(200);
  });

  it("refuses the same payload once re-serialised", async () => {
    const sent = Buffer.from('{ "type" : 1 }');
    const timestamp = nowSeconds();
    const response = await POST(
      requestWith(Buffer.from(JSON.stringify({ type: 1 })), {
        "x-signature-ed25519": signatureFor(timestamp, sent),
        "x-signature-timestamp": timestamp,
      }),
    );
    expect(response.status).toBe(401);
  });

  it("verifies bytes that a text decode would have altered", async () => {
    // Decoding to a string first would replace 0xff and fail the signature with
    // a 401. Passing verification and then failing to parse proves it did not.
    const response = await POST(
      signedBytes(
        Buffer.concat([
          Buffer.from('{"type":1,"a":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe("request size", () => {
  it("does not read an oversized unsigned POST", async () => {
    const { request, pulls } = streamedRequest(10, 1024 * 1024, {
      "content-length": String(10 * 1024 * 1024),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(pulls()).toBe(0);
  });

  it("does not read a body when the signature header is malformed", async () => {
    const { request, pulls } = streamedRequest(1, 16, {
      "x-signature-ed25519": "not-hex",
      "x-signature-timestamp": nowSeconds(),
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(pulls()).toBe(0);
  });

  it("does not read a body declared over the cap", async () => {
    const { request, pulls } = streamedRequest(1, 16, {
      "x-signature-ed25519": WELL_FORMED_SIGNATURE,
      "x-signature-timestamp": nowSeconds(),
      "content-length": String(MAX_BODY_BYTES + 1),
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulls()).toBe(0);
  });

  it.each([
    ["no declared length", {}],
    ["a false declared length", { "content-length": "10" }],
  ])("stops reading past the cap with %s", async (_label, length) => {
    const { request, pulls } = streamedRequest(1000, 16 * 1024, {
      "x-signature-ed25519": WELL_FORMED_SIGNATURE,
      "x-signature-timestamp": nowSeconds(),
      ...length,
    });

    const response = await POST(request);

    expect(response.status).toBe(413);
    expect(pulls()).toBeLessThanOrEqual(6);
  });

  it("accepts a signed body of exactly the cap", async () => {
    const start = Buffer.from(JSON.stringify(ping));
    const padding = Buffer.alloc(MAX_BODY_BYTES - start.length, " ");
    const response = await POST(signedBytes(Buffer.concat([start, padding])));
    expect(response.status).toBe(200);
  });

  it("refuses a signed body one byte over the cap", async () => {
    const start = Buffer.from(JSON.stringify(ping));
    const padding = Buffer.alloc(MAX_BODY_BYTES + 1 - start.length, " ");
    const response = await POST(signedBytes(Buffer.concat([start, padding])));
    expect(response.status).toBe(413);
  });
});

describe("hostile JSON that is correctly signed", () => {
  it("uses the last of duplicate keys, the same as any JSON.parse reader", async () => {
    const lastWins = JSON.stringify(command()).replace(
      `"guild_id":"${ALLOWED_GUILD}"`,
      `"guild_id":"${ALLOWED_GUILD}","guild_id":"${OTHER_GUILD}"`,
    );
    const response = await POST(signedBytes(Buffer.from(lastWins)));
    expect(response.status).toBe(403);
  });

  it("does not let a duplicate type turn a command into a PING", async () => {
    const text = `{"type":1,${JSON.stringify(command()).slice(1)}`;
    const response = await POST(signedBytes(Buffer.from(text)));
    expect(await response.json()).toMatchObject({
      type: InteractionResponseType.ChannelMessageWithSource,
    });
  });

  it("does not read fields through __proto__", async () => {
    const rest = command({ guild_id: undefined, member: undefined });
    const text = JSON.stringify(rest).replace(
      /\}$/,
      `,"__proto__":{"guild_id":"${ALLOWED_GUILD}","member":{"user":{"id":"${"3".repeat(18)}"}}}}`,
    );
    const response = await POST(signedBytes(Buffer.from(text)));
    expect(response.status).toBe(403);
  });

  it("refuses deep nesting inside the cap without crashing", async () => {
    const depth = 30_000;
    const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const response = await POST(
      signedBytes(Buffer.from(`{"type":2,"data":${nested}}`)),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a deeply nested top level inside the cap without crashing", async () => {
    const depth = 32_000;
    const response = await POST(
      signedBytes(Buffer.from(`${"[".repeat(depth)}${"]".repeat(depth)}`)),
    );
    expect(response.status).toBe(403);
  });
});

describe("headers that must not affect a decision", () => {
  const untrusted = {
    host: "bot.example.test",
    "x-forwarded-for": "203.0.113.1",
    "x-forwarded-host": "discord.com",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.1",
    "x-vercel-id": "local",
    "x-vercel-forwarded-for": "203.0.113.1",
    "x-vercel-ip-country": "US",
    "x-vercel-deployment-url": "bot.example.test",
    "x-vercel-protection-bypass": "bypass",
  };

  function withUntrustedHeaders(request: Request): Request {
    for (const [name, value] of Object.entries(untrusted)) {
      request.headers.set(name, value);
    }
    return request;
  }

  it("still refuses a bad signature", async () => {
    const response = await POST(
      withUntrustedHeaders(badlySignedRequest(command())),
    );
    expect(response.status).toBe(401);
  });

  it("still refuses a disallowed guild", async () => {
    const response = await POST(
      withUntrustedHeaders(signedRequest(command({ guild_id: OTHER_GUILD }))),
    );
    expect(response.status).toBe(403);
  });

  it("reads only the signature headers and content-length", async () => {
    const request = withUntrustedHeaders(signedRequest(command()));
    const get = vi.spyOn(request.headers, "get");
    const has = vi.spyOn(request.headers, "has");
    const entries = vi.spyOn(request.headers, "entries");

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(get.mock.calls.map(([name]) => name).sort()).toEqual([
      "content-length",
      "x-signature-ed25519",
      "x-signature-timestamp",
    ]);
    expect(has).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });
});

describe("PING", () => {
  it("answers with PONG", async () => {
    const response = await POST(signedRequest(ping));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      type: InteractionResponseType.Pong,
    });
  });

  it("needs only the public key", async () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", undefined);
    vi.stubEnv("DISCORD_APP_ID", undefined);
    const response = await POST(signedRequest(ping));
    expect(response.status).toBe(200);
  });
});

describe("access", () => {
  it("answers /ping privately and with no mentions", async () => {
    const response = await POST(signedRequest(command()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content: "Pong!",
        flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
        allowed_mentions: { parse: [], users: [] },
      },
    });
  });

  it("refuses a guild that is not allowed", async () => {
    const response = await POST(
      signedRequest(
        command({
          guild_id: OTHER_GUILD,
          authorizing_integration_owners: { "0": OTHER_GUILD },
        }),
      ),
    );
    expect(response.status).toBe(403);
  });

  it.each([
    ["missing", undefined],
    ["a number", 111],
    ["not a Discord ID", "not-an-id"],
  ])("refuses a guild ID that is %s", async (_label, guild_id) => {
    const response = await POST(signedRequest(command({ guild_id })));
    expect(response.status).toBe(403);
  });

  it.each([
    ["another application", OTHER_APP_ID],
    ["missing", undefined],
    ["not a Discord ID", "not-an-id"],
  ])("refuses an application_id that is %s", async (_label, application_id) => {
    const response = await POST(signedRequest(command({ application_id })));
    expect(response.status).toBe(403);
  });

  it.each([
    ["a DM with the bot", InteractionContextType.BotDM],
    ["a private channel", InteractionContextType.PrivateChannel],
    ["missing", undefined],
    ["the string form of guild", "0"],
  ])("refuses a context of %s", async (_label, context) => {
    const response = await POST(signedRequest(command({ context })));
    expect(response.status).toBe(403);
  });

  it.each([
    ["missing", undefined],
    ["empty", {}],
    ["an array", [ALLOWED_GUILD]],
    ["user install only", { "1": "3".repeat(18) }],
    ["another guild", { "0": OTHER_GUILD }],
    ["the DM value", { "0": "0" }],
  ])(
    "refuses authorizing_integration_owners that is %s",
    async (_label, authorizing_integration_owners) => {
      const response = await POST(
        signedRequest(command({ authorizing_integration_owners })),
      );
      expect(response.status).toBe(403);
    },
  );

  it.each([
    ["missing", undefined],
    ["null", null],
    ["an array", []],
    ["empty", {}],
    ["without a user id", { user: {} }],
    ["with a user that is an array", { user: [] }],
    ["with a user id that is not a string", { user: { id: 1 } }],
    ["with a user id that is not a Discord ID", { user: { id: "1" } }],
  ])("refuses a member that is %s", async (_label, member) => {
    const response = await POST(signedRequest(command({ member })));
    expect(response.status).toBe(403);
  });

  it.each([
    ["no channel", { channel: undefined }],
    ["no interaction ID", { id: undefined }],
    ["a malformed channel", { channel: { id: "x", type: 0 } }],
    ["a token of two dots", { token: ".." }],
  ])("refuses a command with %s", async (_label, overrides) => {
    const response = await POST(signedRequest(command(overrides)));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("does not repeat member names in its reply", async () => {
    const hostile = "@everyone [phish](https://evil.example)";
    const response = await POST(
      signedRequest(
        command({
          member: {
            nick: hostile,
            roles: [],
            permissions: "0",
            user: {
              id: "3".repeat(18),
              username: hostile,
              global_name: hostile,
            },
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("phish");
  });

  it("gives an unknown command the fixed private refusal", async () => {
    const response = await POST(
      signedRequest(
        command({
          data: { type: ApplicationCommandType.ChatInput, name: "unknown" },
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED_REFUSAL);
  });

  it("gives a non-chat command that shares a known name the same refusal", async () => {
    const response = await POST(
      signedRequest(
        command({ data: { type: ApplicationCommandType.User, name: "ping" } }),
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(FIXED_REFUSAL);
  });

  it.each([
    ["component", InteractionType.MessageComponent],
    ["autocomplete", InteractionType.ApplicationCommandAutocomplete],
    ["modal", InteractionType.ModalSubmit],
    ["unknown", 99],
  ])(
    "gives the %s interaction type a reply that shows nothing",
    async (_label, type) => {
      const response = await POST(signedRequest(command({ type })));
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("Pong");
    },
  );

  it("keeps refusing a member who is not a usable shape", async () => {
    const response = await POST(
      signedRequest(
        command({ member: { user: { id: "3".repeat(18) }, roles: "x" } }),
      ),
    );
    expect(await response.json()).toEqual(FIXED_REFUSAL);
  });

  it("does not build a database client for a refusal", async () => {
    const response = await POST(
      signedRequest(
        command({
          data: { type: ApplicationCommandType.ChatInput, name: "__proto__" },
        }),
      ),
    );
    expect(response.status).toBe(200);
  });

  it("answers 400 to a signed body that is not JSON", async () => {
    const response = await POST(signedBytes(Buffer.from("not json")));
    expect(response.status).toBe(400);
  });

  it.each(["null", "[]", "1"])(
    "refuses the signed JSON value %s",
    async (text) => {
      const response = await POST(signedBytes(Buffer.from(text)));
      expect(response.status).toBe(403);
    },
  );
});

describe("work done after the reply", () => {
  const ROLE_A = "8".repeat(18);
  const ROLE_B = "9".repeat(18);
  const send = vi.fn<typeof fetch>();
  const roleRow = (id: string) => ({
    id,
    name: "Role",
    managed: false,
    position: 1,
    permissions: "0",
  });
  const setupCommand = () =>
    command({
      member: { user: { id: "3".repeat(18) }, roles: [], permissions: "8" },
      data: {
        type: ApplicationCommandType.ChatInput,
        name: "setup",
        options: [
          { name: "officer_role", type: 8, value: ROLE_A },
          { name: "admin_role", type: 8, value: ROLE_B },
        ],
        resolved: {
          roles: { [ROLE_A]: roleRow(ROLE_A), [ROLE_B]: roleRow(ROLE_B) },
        },
      },
    });

  beforeEach(() => {
    waitUntil.mockReset();
    send.mockReset();
    send.mockImplementation((input, init) => {
      const url = input as string;
      if (url.includes("/rest/v1/")) {
        return Promise.resolve(Response.json([]));
      }
      if (url.endsWith("/roles")) {
        return Promise.resolve(Response.json([roleRow(ROLE_A)]));
      }
      return Promise.resolve(
        Response.json({ id: ROLE_A, flags: init?.method === "GET" ? 64 : 0 }),
      );
    });
    vi.stubGlobal("fetch", send);
    vi.stubEnv("SUPABASE_URL", "https://project.example.test");
    vi.stubEnv(
      "SUPABASE_SECRET_KEY",
      ["sb", "secret", "x".repeat(24)].join("_"),
    );
    vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-bot-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("acknowledges privately, then hands the rest to waitUntil", async () => {
    const response = await POST(signedRequest(setupCommand()));

    expect(await response.json()).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]?.[0];
    const edit = send.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(edit?.[0]).toContain(`/webhooks/${APP_ID}/`);
    expect(edit?.[1]?.body).toContain("Confirm");
  });

  it("does not use waitUntil for a refusal", async () => {
    const response = await POST(
      signedRequest(
        command({
          data: { type: ApplicationCommandType.ChatInput, name: "unknown" },
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("fails closed with a generic error if the bot token is missing", async () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(signedRequest(setupCommand()));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("responses that could post publicly", () => {
  afterEach(() => {
    vi.doUnmock("../handlers/registry.ts");
    vi.resetModules();
  });

  it.each(["interactionReply", "updateMessage", "deferredReply"] as const)(
    "refuses to return %s, even if a handler produces one",
    async (builder) => {
      vi.resetModules();
      vi.doMock("../handlers/registry.ts", async () => {
        const outbound = await import("./outbound.ts");
        const { safe } = await import("./safe-text.ts");
        const text = { content: safe`canary text`, mentionUserIds: [] };
        return {
          ROUTER: {
            handle: () => Promise.resolve({ reply: outbound[builder](text) }),
          },
        };
      });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const endpoint = await import("../../api/interactions.ts");

      const response = await endpoint.POST(signedRequest(command()));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("internal error");
    },
  );
});

describe("failures", () => {
  it.each(["DISCORD_PUBLIC_KEY", "DISCORD_APP_ID", "ALLOWED_GUILD_IDS"])(
    "fails closed when %s is not configured",
    async (name) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.stubEnv(name, undefined);
      const response = await POST(signedRequest(command()));
      expect(response.status).toBe(500);
    },
  );

  it("never logs the body, the token or a setting's value", async () => {
    const logged = vi.fn();
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(logged);
    }

    await POST(signedRequest(command()));
    await POST(signedRequest(command({ guild_id: OTHER_GUILD })));
    await POST(badlySignedRequest(command()));
    vi.stubEnv("ALLOWED_GUILD_IDS", "not-a-guild-id");
    await POST(signedRequest(command()));

    // The configuration failure is the one outcome that writes a log line.
    expect(logged).toHaveBeenCalledOnce();
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain("ALLOWED_GUILD_IDS");
    expect(output).not.toContain(INTERACTION_TOKEN);
    expect(output).not.toContain("not-a-guild-id");
  });
});
