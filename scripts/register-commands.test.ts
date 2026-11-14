import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { COMMANDS } from "../src/handlers/registry.ts";
import {
  asFetch,
  stubEnv,
  stubGlobal,
  type FetchLike,
} from "../test/support/stubs.ts";
import {
  describeFailure,
  main,
  registerGuildCommands,
  RegistrationError,
} from "./register-commands.ts";

const APP_ID = "4".repeat(18);
const GUILD_A = "1".repeat(18);
const GUILD_B = "2".repeat(18);
const OTHER_GUILD = "3".repeat(18);
const TOKEN = "token-that-must-not-be-printed";
const NEWLINE_TOKEN = "token-head-not-printed\ntoken-tail-not-printed";

function registration(guildIds: string[], token = TOKEN) {
  return {
    appId: APP_ID,
    token,
    guildIds,
    allowedGuildIds: new Set([GUILD_A, GUILD_B]),
    commands: COMMANDS,
  };
}

function stubSend(status = 200) {
  return mock<FetchLike>(() => Promise.resolve(new Response(null, { status })));
}

beforeEach(() => {
  spyOn(console, "log").mockImplementation(() => undefined);
});

describe("registerGuildCommands", () => {
  it("replaces the commands of each given server and nowhere else", async () => {
    const send = stubSend();

    await registerGuildCommands(
      registration([GUILD_A, GUILD_B]),
      asFetch(send),
    );

    expect(send.mock.calls.map(([url]) => url)).toEqual([
      `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_A}/commands`,
      `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_B}/commands`,
    ]);
    const init = send.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ Authorization: `Bot ${TOKEN}` });
    expect(init?.body).toBe(JSON.stringify(COMMANDS));
  });

  it("sends nothing if any server is not allowed", () => {
    const send = stubSend();

    expect(
      registerGuildCommands(
        registration([GUILD_A, OTHER_GUILD]),
        asFetch(send),
      ),
    ).rejects.toThrow("Server ID 2 on the command line");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops at the first refusal without printing the token", async () => {
    const send = stubSend(403);

    const error: unknown = await registerGuildCommands(
      registration([GUILD_A, GUILD_B]),
      asFetch(send),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RegistrationError);
    expect(String(error)).toContain(`403 for server ${GUILD_A}`);
    expect(String(error)).not.toContain(TOKEN);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("describeFailure", () => {
  it("keeps the token out when real fetch refuses a newline in it", async () => {
    // Real fetch rejects the header before opening a connection, and quotes the
    // header in its message. Printing that message would print the token.
    const error: unknown = await registerGuildCommands(
      registration([GUILD_A], NEWLINE_TOKEN),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RegistrationError);
    const printed = describeFailure(error);
    expect(printed).not.toContain("token-head");
    expect(printed).not.toContain("token-tail");
  });

  it("prints only the type of an unexpected error", () => {
    expect(describeFailure(new TypeError(`Bot ${TOKEN}`))).toBe("TypeError");
    expect(describeFailure(`Bot ${TOKEN}`)).toBe("unknown error");
  });
});

describe("main", () => {
  function stubSettings(token = TOKEN) {
    stubEnv("DISCORD_APP_ID", APP_ID);
    stubEnv("DISCORD_BOT_TOKEN", token);
    stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},${GUILD_B}`);
  }

  function captureErrors() {
    return spyOn(console, "error").mockImplementation(() => undefined);
  }

  it("registers an allowed server", async () => {
    stubSettings();
    const send = stubSend();
    stubGlobal("fetch", send);

    expect(await main([GUILD_A])).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses a server outside ALLOWED_GUILD_IDS before any request", async () => {
    stubSettings();
    const errors = captureErrors();
    const send = stubSend();
    stubGlobal("fetch", send);

    expect(await main([GUILD_A, OTHER_GUILD])).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(errors.mock.calls[0]?.[0]).toContain("ALLOWED_GUILD_IDS");
  });

  it("rejects a newline token before any request and does not print it", async () => {
    stubSettings(NEWLINE_TOKEN);
    const errors = captureErrors();
    const send = stubSend();
    stubGlobal("fetch", send);

    expect(await main([GUILD_A])).toBe(1);
    expect(send).not.toHaveBeenCalled();
    const output = JSON.stringify(errors.mock.calls);
    expect(output).toContain("DISCORD_BOT_TOKEN");
    expect(output).not.toContain("token-head");
    expect(output).not.toContain("token-tail");
  });

  it("does not print a message from a failed request", async () => {
    stubSettings();
    const errors = captureErrors();
    stubGlobal(
      "fetch",
      mock(() => Promise.reject(new Error(`Bot ${TOKEN}`))),
    );

    expect(await main([GUILD_A])).toBe(1);
    expect(errors.mock.calls).toEqual([["Error"]]);
  });
});
