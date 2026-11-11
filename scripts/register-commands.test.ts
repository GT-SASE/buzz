import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/handlers/registry.ts";
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
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(new Response(null, { status })),
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("registerGuildCommands", () => {
  it("has guild-level definitions for /setup and /config", () => {
    expect(COMMANDS.map((command) => command.name)).toEqual(
      expect.arrayContaining(["setup", "config"]),
    );
  });

  it("replaces the commands of each given server and nowhere else", async () => {
    const send = stubSend();

    await registerGuildCommands(registration([GUILD_A, GUILD_B]), send);

    expect(send.mock.calls.map(([url]) => url)).toEqual([
      `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_A}/commands`,
      `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_B}/commands`,
    ]);
    const init = send.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({ Authorization: `Bot ${TOKEN}` });
    expect(init?.body).toBe(JSON.stringify(COMMANDS));
  });

  it("sends nothing if any server is not allowed", async () => {
    const send = stubSend();

    await expect(
      registerGuildCommands(registration([GUILD_A, OTHER_GUILD]), send),
    ).rejects.toThrow("Server ID 2 on the command line");
    expect(send).not.toHaveBeenCalled();
  });

  it("does not repeat a refused argument", async () => {
    const pasted = "something-pasted-by-mistake";

    await expect(
      registerGuildCommands(registration([pasted]), stubSend()),
    ).rejects.not.toThrow(pasted);
  });

  it("stops at the first refusal without printing the token", async () => {
    const send = stubSend(403);

    const failure = registerGuildCommands(
      registration([GUILD_A, GUILD_B]),
      send,
    );

    await expect(failure).rejects.toThrow(`403 for server ${GUILD_A}`);
    await expect(failure).rejects.not.toThrow(TOKEN);
    expect(send).toHaveBeenCalledOnce();
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
    vi.stubEnv("DISCORD_APP_ID", APP_ID);
    vi.stubEnv("DISCORD_BOT_TOKEN", token);
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},${GUILD_B}`);
  }

  function captureErrors() {
    const errors = vi.fn();
    vi.spyOn(console, "error").mockImplementation(errors);
    return errors;
  }

  it("registers an allowed server", async () => {
    stubSettings();
    const send = stubSend();
    vi.stubGlobal("fetch", send);

    await expect(main([GUILD_A])).resolves.toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it("refuses a server outside ALLOWED_GUILD_IDS before any request", async () => {
    stubSettings();
    const errors = captureErrors();
    const send = stubSend();
    vi.stubGlobal("fetch", send);

    await expect(main([GUILD_A, OTHER_GUILD])).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect(errors.mock.calls[0]?.[0]).toContain("ALLOWED_GUILD_IDS");
  });

  it("refuses to run without ALLOWED_GUILD_IDS", async () => {
    stubSettings();
    vi.stubEnv("ALLOWED_GUILD_IDS", undefined);
    captureErrors();
    const send = stubSend();
    vi.stubGlobal("fetch", send);

    await expect(main([GUILD_A])).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a newline token before any request and does not print it", async () => {
    stubSettings(NEWLINE_TOKEN);
    const errors = captureErrors();
    const send = stubSend();
    vi.stubGlobal("fetch", send);

    await expect(main([GUILD_A])).resolves.toBe(1);
    expect(send).not.toHaveBeenCalled();
    const output = JSON.stringify(errors.mock.calls);
    expect(output).toContain("DISCORD_BOT_TOKEN");
    expect(output).not.toContain("token-head");
    expect(output).not.toContain("token-tail");
  });

  it("does not print a message from a failed request", async () => {
    stubSettings();
    const errors = captureErrors();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.reject(new Error(`Bot ${TOKEN}`))),
    );

    await expect(main([GUILD_A])).resolves.toBe(1);
    expect(errors.mock.calls).toEqual([["Error"]]);
  });

  it("asks for a server ID when given none", async () => {
    stubSettings();
    const errors = captureErrors();

    await expect(main([])).resolves.toBe(1);
    expect(errors.mock.calls[0]?.[0]).toContain("at least one");
  });
});
