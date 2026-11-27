import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { formatBotCommands } from "./bot";
import { CHECK_TASKS, runChecks } from "./checks";
import { formatProcedures } from "./procedures";
import { deployStatus, migrations, version } from "./project";
import { readRepoFile } from "./repo";
import { formatRoutes } from "./routes";
import { describeSchema } from "./schema";

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  isError,
});

/** Wraps a handler so a thrown error comes back as a tool error. */
const guarded =
  <A>(fn: (args: A) => Promise<string> | string) =>
  async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return text(`Error: ${(e as Error).message}`, true);
    }
  };

export function createServer(serverVersion = "0.0.0"): McpServer {
  const server = new McpServer({ name: "buzz", version: serverVersion });

  server.registerResource(
    "agents-guide",
    "buzz://AGENTS.md",
    {
      title: "AGENTS.md",
      description: "Onboarding guide for agents working on buzz.",
      mimeType: "text/markdown",
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: readRepoFile("AGENTS.md"),
        },
      ],
    }),
  );

  server.registerTool(
    "buzz_guide",
    {
      description:
        "Returns AGENTS.md: repo layout, commands, safety rules, workflow and how-tos. Read first.",
    },
    guarded(() => readRepoFile("AGENTS.md")),
  );

  server.registerTool(
    "buzz_trpc_procedures",
    {
      description:
        "Lists tRPC procedures parsed from packages/api: name, access builder, query/mutation, file:line.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring of the procedure path, e.g. 'page' or 'event.create'.",
          ),
      },
    },
    guarded(({ filter }) => formatProcedures(filter)),
  );

  server.registerTool(
    "buzz_db_schema",
    {
      description:
        "Describes both databases. buzz: Drizzle tables from packages/db/src/schema.ts (columns, PKs, FKs, unique constraints, indexes, checks). bot: the Discord bot's tables, enums, domains and functions (with signatures), read from an in-memory PGlite after applying sites/discord-bot/db/drizzle, grouped by schema (a failing migration is returned as the error).",
      inputSchema: {
        table: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring of the table, export, enum or function name.",
          ),
        database: z
          .enum(["all", "buzz", "bot"])
          .optional()
          .describe("Which database to describe. Default all."),
      },
    },
    guarded(({ table, database }) => describeSchema(table, database)),
  );

  server.registerTool(
    "buzz_migrations",
    {
      description:
        "Lists buzz Drizzle migrations (packages/db/drizzle) and the bot's Drizzle migrations (sites/discord-bot/db/drizzle), each with its process. Bot migrations in production are a manual owner step.",
    },
    guarded(() => migrations()),
  );

  server.registerTool(
    "buzz_routes",
    {
      description:
        "Lists Next.js app routes (pages and route handlers) tagged marketing, portal member, portal admin or api. The Discord bot's interactions and cron endpoints are route handlers there too.",
    },
    guarded(() => formatRoutes()),
  );

  server.registerTool(
    "buzz_bot_commands",
    {
      description:
        "Lists the Discord bot's slash commands with subcommands and options (type, required, choices, limits), derived from the command definitions scripts/register-commands.ts sends to Discord.",
      inputSchema: {
        filter: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the command name."),
      },
    },
    guarded(({ filter }) => formatBotCommands(filter)),
  );

  server.registerTool(
    "buzz_version",
    {
      description:
        "Site version: package.json MAJOR.MINOR, computed build version, README version table, and every workspace (including @buzz/discord-bot) with mismatches flagged.",
    },
    guarded(() => version()),
  );

  server.registerTool(
    "buzz_run_checks",
    {
      description:
        "Runs turbo checks with SKIP_ENV_VALIDATION=1 and returns pass/fail plus the last 80 lines. 'test' and the bot tasks 'bot:test' and 'bot:test:db' (turbo test / test:db in @buzz/discord-bot) need TEST_DATABASE_URL on a local scratch database in this server's env; they are refused otherwise. 'bot:test:db:concurrency' also needs CONCURRENCY_DATABASE_URL (and BOT_APP_PASSWORD) in the env, and CONCURRENCY_DATABASE_URL must pass the same local-scratch guard.",
      inputSchema: {
        tasks: z.array(z.enum(CHECK_TASKS)).min(1),
        force: z
          .boolean()
          .optional()
          .describe(
            "Bypass the turbo cache (cache is shared across git worktrees).",
          ),
      },
    },
    async ({ tasks, force }) => {
      const r = await runChecks(tasks, force);
      return text(`${r.ok ? "PASS" : "FAIL"}\n${r.output}`, !r.ok);
    },
  );

  server.registerTool(
    "buzz_deploy_status",
    {
      description:
        "Latest main commit, its GitHub Vercel status, the latest GitHub CI conclusion for main (gh run list; says so if gh is unavailable), and the live site footer version. Vercel success alone does not mean CI is green. Does not call /api/health or any database route.",
    },
    guarded(() => deployStatus()),
  );

  return server;
}
