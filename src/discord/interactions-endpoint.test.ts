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
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { POST } from "../../api/interactions.ts";
import {
  names,
  recordingSql,
  testDatabaseUrl,
} from "../../test/support/sql-client.ts";
import {
  stubEnv,
  stubGlobal,
  type FetchLike,
} from "../../test/support/stubs.ts";
import * as registry from "../handlers/registry.ts";
import * as outbound from "./outbound.ts";
import { safe } from "./safe-text.ts";

const realRegistry = { ...registry };

const waitUntil = mock<(work: Promise<unknown>) => void>();
await mock.module("@vercel/functions", () => ({ waitUntil }));
// The database the endpoint builds from its settings reads nothing, and saves a draft.
await mock.module("../db/neon.ts", () => ({
  neonRunner: () =>
    recordingSql((call) => ({
      rows: names(call, "save_setup_draft") ? [{ value: true }] : [],
    })).sql,
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32)
  .toString("hex");

const ALLOWED_GUILD = "1".repeat(18);
const OTHER_GUILD = "2".repeat(18);
const MEMBER = "3".repeat(18);
const APP_ID = "4".repeat(18);
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
    member: { user: { id: MEMBER }, roles: [], permissions: "0" },
    data: { type: ApplicationCommandType.ChatInput, name: "ping" },
    ...overrides,
  };
}

const ping = { type: InteractionType.Ping };

beforeEach(() => {
  waitUntil.mockClear();
  stubEnv("DISCORD_PUBLIC_KEY", publicKeyHex);
  stubEnv("DISCORD_APP_ID", APP_ID);
  stubEnv("ALLOWED_GUILD_IDS", ALLOWED_GUILD);
});

describe("signature checks", () => {
  it("accepts a valid signature, needing only the public key", async () => {
    stubEnv("ALLOWED_GUILD_IDS", undefined);
    stubEnv("DISCORD_APP_ID", undefined);

    const response = await POST(signedRequest(ping));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      type: InteractionResponseType.Pong,
    });
  });

  it("refuses a bad signature", async () => {
    const response = await POST(badlySignedRequest(command()));
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

  it.each(["x-signature-ed25519", "x-signature-timestamp"])(
    "refuses a request without %s",
    async (missing) => {
      const request = signedRequest(ping);
      request.headers.delete(missing);

      expect((await POST(request)).status).toBe(401);
    },
  );

  it("refuses a correctly signed timestamp older than 5 minutes", async () => {
    const stale = String(Number(nowSeconds()) - 301);
    expect((await POST(signedRequest(ping, stale))).status).toBe(401);
  });

  it("reads only the signature headers and content-length", async () => {
    const request = signedRequest(command());
    request.headers.set("x-forwarded-host", "discord.com");
    const get = spyOn(request.headers, "get");
    const has = spyOn(request.headers, "has");

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(get.mock.calls.map(([name]) => name).sort()).toEqual([
      "content-length",
      "x-signature-ed25519",
      "x-signature-timestamp",
    ]);
    expect(has).not.toHaveBeenCalled();
  });
});

describe("request size", () => {
  it("does not read an oversized unsigned POST", async () => {
    const { request, pulls } = streamedRequest(10, 1024 * 1024, {
      "content-length": String(10 * 1024 * 1024),
    });

    expect((await POST(request)).status).toBe(401);
    expect(pulls()).toBe(0);
  });

  it.each([
    [MAX_BODY_BYTES, 200],
    [MAX_BODY_BYTES + 1, 413],
  ])("answers a signed body of %i bytes with %i", async (size, status) => {
    const start = Buffer.from(JSON.stringify(ping));
    const padding = Buffer.alloc(size - start.length, " ");
    const response = await POST(signedBytes(Buffer.concat([start, padding])));
    expect(response.status).toBe(status);
  });
});

describe("hostile JSON that is correctly signed", () => {
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
      `,"__proto__":{"guild_id":"${ALLOWED_GUILD}","member":{"user":{"id":"${MEMBER}"}}}}`,
    );
    const response = await POST(signedBytes(Buffer.from(text)));
    expect(response.status).toBe(403);
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

  it.each<[string, Record<string, unknown>]>([
    ["a guild that is not allowed", { guild_id: OTHER_GUILD }],
    ["another application", { application_id: "5".repeat(18) }],
    ["a DM context", { context: InteractionContextType.BotDM }],
    ["a user install", { authorizing_integration_owners: { "1": MEMBER } }],
    ["a member id that is not an ID", { member: { user: { id: "1" } } }],
    ["a token of two dots", { token: ".." }],
  ])("refuses %s", async (_label, overrides) => {
    const response = await POST(signedRequest(command(overrides)));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("forbidden");
  });

  it("does not repeat member names in its reply", async () => {
    const hostile = "@everyone [phish](https://evil.example)";
    const member = {
      nick: hostile,
      roles: [],
      permissions: "0",
      user: { id: MEMBER, username: hostile, global_name: hostile },
    };

    const response = await POST(signedRequest(command({ member })));

    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("phish");
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unknown command", { data: { type: 1, name: "unknown" } }],
    ["a user command named ping", { data: { type: 2, name: "ping" } }],
    [
      "a member of the wrong shape",
      { member: { user: { id: MEMBER }, roles: "x" } },
    ],
  ])("gives %s the fixed private refusal", async (_label, overrides) => {
    const response = await POST(signedRequest(command(overrides)));

    expect(await response.json()).toEqual({
      type: InteractionResponseType.ChannelMessageWithSource,
      data: {
        content: "You can't do that, or it doesn't exist.",
        flags: MessageFlags.Ephemeral | MessageFlags.SuppressEmbeds,
        allowed_mentions: { parse: [], users: [] },
      },
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("work done after the reply", () => {
  const ROLE_A = "8".repeat(18);
  const ROLE_B = "9".repeat(18);
  const send = mock<FetchLike>();
  const roleRow = (id: string) => ({
    id,
    name: "Role",
    managed: false,
    position: 1,
    permissions: "0",
  });
  const roleOptions = [
    "events_directors_role",
    "events_committee_role",
    "treasury_role",
    "marketing_role",
  ].map((name) => ({ name, type: 8, value: ROLE_A }));
  const setupCommand = command({
    member: { user: { id: MEMBER }, roles: [], permissions: "8" },
    data: {
      type: ApplicationCommandType.ChatInput,
      name: "setup",
      options: [
        { name: "eboard_role", type: 8, value: ROLE_B },
        ...roleOptions,
      ],
      resolved: {
        roles: { [ROLE_A]: roleRow(ROLE_A), [ROLE_B]: roleRow(ROLE_B) },
      },
    },
  });

  beforeEach(() => {
    send.mockReset();
    send.mockImplementation((input, init) => {
      if ((input as string).endsWith("/roles")) {
        return Promise.resolve(Response.json([roleRow(ROLE_A)]));
      }
      return Promise.resolve(
        Response.json({ id: ROLE_A, flags: init?.method === "GET" ? 64 : 0 }),
      );
    });
    stubGlobal("fetch", send);
    stubEnv("DATABASE_URL", testDatabaseUrl());
    stubEnv("DISCORD_BOT_TOKEN", "unit-test-bot-token");
  });

  it("acknowledges privately, then hands the rest to waitUntil", async () => {
    const response = await POST(signedRequest(setupCommand));

    expect(await response.json()).toEqual({
      type: InteractionResponseType.DeferredChannelMessageWithSource,
      data: { flags: MessageFlags.Ephemeral },
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0]?.[0];
    const edit = send.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(edit?.[0]).toContain(`/webhooks/${APP_ID}/`);
    expect(edit?.[1]?.body).toContain("Confirm");
  });
});

describe("responses that could post publicly", () => {
  afterEach(async () => {
    await mock.module("../handlers/registry.ts", () => realRegistry);
  });

  it.each(["interactionReply", "updateMessage", "deferredReply"] as const)(
    "refuses to return %s, even if a handler produces one",
    async (builder) => {
      const text = { content: safe`canary text`, mentionUserIds: [] };
      await mock.module("../handlers/registry.ts", () => ({
        ...realRegistry,
        ROUTER: {
          handle: () => Promise.resolve({ reply: outbound[builder](text) }),
        },
      }));
      spyOn(console, "error").mockImplementation(() => undefined);

      const response = await POST(signedRequest(command()));

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("internal error");
    },
  );
});

describe("failures", () => {
  it.each(["DISCORD_PUBLIC_KEY", "DISCORD_APP_ID", "ALLOWED_GUILD_IDS"])(
    "fails closed when %s is not configured",
    async (name) => {
      spyOn(console, "error").mockImplementation(() => undefined);
      stubEnv(name, undefined);
      const response = await POST(signedRequest(command()));
      expect(response.status).toBe(500);
    },
  );

  it("never logs the body, the token or a setting's value", async () => {
    const logged = mock<(...args: unknown[]) => void>();
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spyOn(console, method).mockImplementation(logged);
    }

    await POST(signedRequest(command()));
    await POST(signedRequest(command({ guild_id: OTHER_GUILD })));
    await POST(badlySignedRequest(command()));
    stubEnv("ALLOWED_GUILD_IDS", "not-a-guild-id");
    await POST(signedRequest(command()));

    // The configuration failure is the one outcome that writes a log line.
    expect(logged).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain("ALLOWED_GUILD_IDS");
    expect(output).not.toContain(INTERACTION_TOKEN);
    expect(output).not.toContain("not-a-guild-id");
  });
});
