import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "./config-error.ts";
import {
  getAllowedGuildIds,
  getDatabaseUrl,
  getDiscordAppId,
  getDiscordBotToken,
  getDiscordPublicKey,
} from "./env.ts";

const GUILD_A = "1".repeat(18);
const GUILD_B = "2".repeat(18);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("required settings", () => {
  it.each([
    ["DISCORD_APP_ID", getDiscordAppId],
    ["DISCORD_BOT_TOKEN", getDiscordBotToken],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds],
  ])("refuses a missing or blank %s", (name, read) => {
    vi.stubEnv(name, undefined);
    expect(read).toThrow(ConfigError);

    vi.stubEnv(name, "   ");
    expect(read).toThrow(ConfigError);
  });

  it.each([
    ["DISCORD_APP_ID", getDiscordAppId],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds],
  ])("names %s when its value is rejected", (name, read) => {
    vi.stubEnv(name, "not a valid value");

    expect(read).toThrow(name);
  });
});

describe("getDiscordBotToken", () => {
  it("accepts printable ASCII", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "abc.DEF-123_~");
    expect(getDiscordBotToken()).toBe("abc.DEF-123_~");
  });

  it("ignores surrounding whitespace, such as a final newline", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "abc.DEF\n");
    expect(getDiscordBotToken()).toBe("abc.DEF");
  });

  it.each([
    ["an interior newline", "head\ntail"],
    ["an interior space", "head tail"],
    ["a control character", "head\x7ftail"],
    ["a non-ASCII character", "headétail"],
  ])("refuses %s", (_label, token) => {
    vi.stubEnv("DISCORD_BOT_TOKEN", token);

    expect(getDiscordBotToken).toThrow(ConfigError);
    expect(getDiscordBotToken).toThrow("DISCORD_BOT_TOKEN");
  });
});

describe("getDiscordPublicKey", () => {
  it("accepts 32 bytes of hex", () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", "ab".repeat(32));
    expect(getDiscordPublicKey()).toBe("ab".repeat(32));
  });

  it("refuses the wrong length", () => {
    vi.stubEnv("DISCORD_PUBLIC_KEY", "ab".repeat(31));
    expect(getDiscordPublicKey).toThrow(ConfigError);
  });
});

describe("getAllowedGuildIds", () => {
  it("splits and trims the list", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A}, ${GUILD_B}`);
    expect(getAllowedGuildIds()).toEqual(new Set([GUILD_A, GUILD_B]));
  });

  it("fails the whole list when one entry is malformed", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},not-an-id`);
    expect(getAllowedGuildIds).toThrow(ConfigError);
  });

  it("refuses an empty entry", () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A},`);
    expect(getAllowedGuildIds).toThrow(ConfigError);
  });
});

describe("DATABASE_URL", () => {
  it("returns the value, trimmed", () => {
    vi.stubEnv("DATABASE_URL", " postgresql://example.test/bot\n");
    expect(getDatabaseUrl()).toBe("postgresql://example.test/bot");
  });

  it("refuses it missing or blank", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(getDatabaseUrl).toThrow("must be set");
    vi.stubEnv("DATABASE_URL", "  ");
    expect(getDatabaseUrl).toThrow("must be set");
  });
});
