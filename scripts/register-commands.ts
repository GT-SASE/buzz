/**
 * Registers the bot's slash commands with specific Discord servers.
 *
 * Commands are only ever registered per server, never globally, and only in
 * servers listed in ALLOWED_GUILD_IDS. Each request replaces that server's whole
 * command list with the one in this repository.
 *
 * Reads DISCORD_APP_ID, DISCORD_BOT_TOKEN and ALLOWED_GUILD_IDS from the
 * environment.
 *
 * Usage:
 *   npm run commands:register -- <guild-id> [<guild-id>...]
 */

import { parseArgs } from "node:util";
import {
  RouteBases,
  Routes,
  type RESTPutAPIApplicationGuildCommandsJSONBody,
} from "discord-api-types/v10";
import { COMMANDS } from "../src/handlers/registry.ts";
import { ConfigError } from "../src/lib/config-error.ts";
import {
  getAllowedGuildIds,
  getDiscordAppId,
  getDiscordBotToken,
} from "../src/lib/env.ts";

const REQUEST_TIMEOUT_MS = 10_000;

/** A failure whose message was written here and is safe to print. */
export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
}

export interface Registration {
  appId: string;
  token: string;
  guildIds: readonly string[];
  allowedGuildIds: ReadonlySet<string>;
  commands: RESTPutAPIApplicationGuildCommandsJSONBody;
}

/** Checks every server before the first request, and stops at any refusal. */
export async function registerGuildCommands(
  { appId, token, guildIds, allowedGuildIds, commands }: Registration,
  send: typeof fetch = fetch,
): Promise<void> {
  for (const [index, guildId] of guildIds.entries()) {
    // Reports the position, because a mistyped argument could be anything.
    if (!allowedGuildIds.has(guildId)) {
      throw new RegistrationError(
        `Server ID ${String(index + 1)} on the command line is not in ALLOWED_GUILD_IDS`,
      );
    }
  }

  for (const guildId of guildIds) {
    const response = await send(
      `${RouteBases.api}${Routes.applicationGuildCommands(appId, guildId)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "DiscordBot (gtsase-discord-bot, 0.0.0)",
        },
        body: JSON.stringify(commands),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new RegistrationError(
        `Discord answered ${String(response.status)} for server ${guildId}`,
      );
    }
    console.log(
      `Registered ${String(commands.length)} command(s) in server ${guildId}`,
    );
  }
}

/**
 * Errors from elsewhere can quote what they were given, including the
 * Authorization header, so only the type of those is ever printed.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof ConfigError || error instanceof RegistrationError) {
    return error.message;
  }
  return error instanceof Error ? error.name : "unknown error";
}

export async function main(args: string[] = process.argv.slice(2)) {
  try {
    const { positionals: guildIds } = parseArgs({
      args,
      allowPositionals: true,
    });
    if (guildIds.length === 0) {
      throw new RegistrationError("Pass at least one Discord server ID.");
    }
    await registerGuildCommands({
      appId: getDiscordAppId(),
      token: getDiscordBotToken(),
      guildIds,
      allowedGuildIds: getAllowedGuildIds(),
      commands: COMMANDS,
    });
    return 0;
  } catch (error) {
    console.error(describeFailure(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
