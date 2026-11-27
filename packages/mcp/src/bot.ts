import { pathToFileURL } from "node:url";

import { repoPath } from "./repo";

const BOT_DIR = "sites/discord-bot";
export const BOT_MIGRATIONS_DIR = `${BOT_DIR}/db/drizzle`;

export type BotFunction = { route: string; source: string };
export type BotCron = { path: string; schedule: string };

/** Loads a bot module by file URL so the MCP typecheck does not follow it. */
async function importBot<T>(file: string): Promise<T> {
  return (await import(pathToFileURL(repoPath(BOT_DIR, file)).href)) as T;
}

/** The bot's Vercel functions and crons, from scripts/deployment.ts. */
export async function formatBotRoutes(): Promise<string> {
  const { FUNCTIONS, CRONS } = await importBot<{
    FUNCTIONS: BotFunction[];
    CRONS: BotCron[];
  }>("scripts/deployment.ts");
  return [
    ...FUNCTIONS.map(
      (f) => `/${f.route}  [bot function]  ${BOT_DIR}/${f.source}`,
    ),
    ...CRONS.map(
      (c) => `/${c.path.replace(/^\//, "")}  [bot cron]  ${c.schedule}`,
    ),
  ].join("\n");
}

type Choice = { name: string; value: string | number };
type Option = {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: Choice[];
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  channel_types?: number[];
  options?: Option[];
};
type Command = Option & {
  default_member_permissions?: string | null;
  contexts?: number[] | null;
};

const OPTION_TYPES: Record<number, string> = {
  1: "subcommand",
  2: "subcommand group",
  3: "string",
  4: "integer",
  5: "boolean",
  6: "user",
  7: "channel",
  8: "role",
  9: "mentionable",
  10: "number",
  11: "attachment",
};

function describeOption(o: Option, depth: number): string[] {
  const pad = "  ".repeat(depth);
  const kind = OPTION_TYPES[o.type] ?? `type ${o.type}`;
  if (o.type === 1 || o.type === 2) {
    return [
      `${pad}${o.name}  (${kind})  ${o.description ?? ""}`.trimEnd(),
      ...(o.options ?? []).flatMap((s) => describeOption(s, depth + 1)),
    ];
  }
  const extras = [
    o.required ? "required" : "optional",
    o.autocomplete ? "autocomplete" : "",
    o.choices ? `choices: ${o.choices.map((c) => c.name).join("|")}` : "",
    o.min_value !== undefined ? `min ${o.min_value}` : "",
    o.max_value !== undefined ? `max ${o.max_value}` : "",
    o.min_length !== undefined ? `min length ${o.min_length}` : "",
    o.max_length !== undefined ? `max length ${o.max_length}` : "",
    o.channel_types ? `channel types ${o.channel_types.join(",")}` : "",
  ].filter(Boolean);
  return [
    `${pad}${o.name}: ${kind}  ${extras.join(", ")}  ${o.description ?? ""}`.trimEnd(),
  ];
}

function describeCommands(commands: Command[], filter?: string): string {
  const f = filter?.trim().toLowerCase();
  const blocks = commands
    .filter((c) => !f || c.name.toLowerCase().includes(f))
    .map((c) => {
      const head = [`/${c.name}  ${c.description ?? ""}`.trimEnd()];
      if (c.default_member_permissions) {
        head.push(
          `  default_member_permissions: ${c.default_member_permissions}`,
        );
      }
      const body = (c.options ?? []).flatMap((o) => describeOption(o, 1));
      return [...head, ...body].join("\n");
    });
  return blocks.length ? blocks.join("\n\n") : "No matching commands.";
}

/**
 * The slash commands exactly as scripts/register-commands.ts sends them. The
 * registry only builds objects and reads no env, so importing it is safe.
 */
export async function formatBotCommands(filter?: string): Promise<string> {
  const { COMMANDS } = await importBot<{ COMMANDS: Command[] }>(
    "src/handlers/registry.ts",
  );
  return describeCommands(COMMANDS, filter);
}
