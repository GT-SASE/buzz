/**
 * Access to required settings. Each one is read and checked when it is needed,
 * so importing this module never fails and a route only depends on the settings
 * it uses. Errors name the setting and never include its value.
 */

import { isSnowflake } from "./snowflake.ts";

/**
 * Thrown when a required setting is missing or malformed. The message names the
 * setting and never includes its value, because the value may be a secret and
 * this message may reach the logs.
 */
export class ConfigError extends Error {
  readonly setting: string;

  constructor(setting: string, reason: string) {
    super(`Invalid configuration for ${setting}: ${reason}`);
    this.name = "ConfigError";
    this.setting = setting;
  }
}

const ED25519_PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/i;
const BOT_TOKEN = /^[\x21-\x7e]+$/;

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigError(name, "must be set");
  }
  return value;
}

/**
 * The bot's own role (`bot_app`). It is not `DATABASE_URL`: the web app that hosts the
 * bot uses that name for its own role.
 */
export function getDatabaseUrl(): string {
  return readRequired("DISCORD_BOT_DATABASE_URL");
}

export function getDiscordAppId(): string {
  const value = readRequired("DISCORD_APP_ID");
  if (!isSnowflake(value)) {
    throw new ConfigError("DISCORD_APP_ID", "must be a Discord ID");
  }
  return value;
}

export function getDiscordBotToken(): string {
  const value = readRequired("DISCORD_BOT_TOKEN");
  // Anything else cannot go in a header, and HTTP clients quote the rejected
  // header in their errors, which would print the token.
  if (!BOT_TOKEN.test(value)) {
    throw new ConfigError(
      "DISCORD_BOT_TOKEN",
      "must contain only printable ASCII with no spaces",
    );
  }
  return value;
}

export function getDiscordPublicKey(): string {
  const value = readRequired("DISCORD_PUBLIC_KEY");
  if (!ED25519_PUBLIC_KEY_HEX.test(value)) {
    throw new ConfigError("DISCORD_PUBLIC_KEY", "must be 64 hex characters");
  }
  return value;
}

/** A malformed entry fails the whole list, so a typo cannot widen access. */
export function getAllowedGuildIds(): ReadonlySet<string> {
  const ids = readRequired("ALLOWED_GUILD_IDS")
    .split(",")
    .map((id) => id.trim());
  if (!ids.every(isSnowflake)) {
    throw new ConfigError(
      "ALLOWED_GUILD_IDS",
      "must be a comma-separated list of Discord IDs",
    );
  }
  return new Set(ids);
}
