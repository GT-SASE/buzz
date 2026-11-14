import { describe, expect, it } from "bun:test";
import { stubEnv } from "../../test/support/stubs.ts";
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

describe("required settings", () => {
  it.each([
    ["DISCORD_APP_ID", getDiscordAppId],
    ["DISCORD_BOT_TOKEN", getDiscordBotToken],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds],
    ["DATABASE_URL", getDatabaseUrl],
  ])("refuses a missing or blank %s", (name, read) => {
    stubEnv(name, undefined);
    expect(read).toThrow(ConfigError);

    stubEnv(name, "   ");
    expect(read).toThrow(ConfigError);
  });

  it.each([
    ["DISCORD_APP_ID", getDiscordAppId, "not a valid value"],
    ["DISCORD_BOT_TOKEN", getDiscordBotToken, "head\ntail"],
    ["DISCORD_PUBLIC_KEY", getDiscordPublicKey, "ab".repeat(31)],
    ["ALLOWED_GUILD_IDS", getAllowedGuildIds, `${GUILD_A},not-an-id`],
  ])("names %s when its value is rejected", (name, read, value) => {
    stubEnv(name, value);

    expect(read).toThrow(ConfigError);
    expect(read).toThrow(name);
  });
});

describe("accepted values", () => {
  it("trims the bot token and the database URL", () => {
    stubEnv("DISCORD_BOT_TOKEN", "abc.DEF-123_~\n");
    stubEnv("DATABASE_URL", " postgresql://example.test/bot\n");

    expect(getDiscordBotToken()).toBe("abc.DEF-123_~");
    expect(getDatabaseUrl()).toBe("postgresql://example.test/bot");
  });

  it("splits and trims the guild list", () => {
    stubEnv("ALLOWED_GUILD_IDS", `${GUILD_A}, ${GUILD_B}`);
    expect(getAllowedGuildIds()).toEqual(new Set([GUILD_A, GUILD_B]));
  });
});
