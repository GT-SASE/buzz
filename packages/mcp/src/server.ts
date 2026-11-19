import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

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
        "Describes Drizzle tables from packages/db/src/schema.ts: columns, PKs, FKs, unique constraints, indexes, checks.",
      inputSchema: {
        table: z
          .string()
          .optional()
          .describe("Case-insensitive substring of the table or export name."),
      },
    },
    guarded(({ table }) => describeSchema(table)),
  );

  server.registerTool(
    "buzz_migrations",
    {
      description:
        "Lists SQL migrations in packages/db/drizzle, the latest number, and the migration process.",
    },
    guarded(() => migrations()),
  );

  server.registerTool(
    "buzz_routes",
    {
      description:
        "Lists Next.js app routes (pages and route handlers) tagged marketing, portal member, portal admin or api.",
    },
    guarded(() => formatRoutes()),
  );

  server.registerTool(
    "buzz_version",
    {
      description:
        "Site version: package.json MAJOR.MINOR, computed build version, README version table.",
    },
    guarded(() => version()),
  );

  server.registerTool(
    "buzz_run_checks",
    {
      description:
        "Runs turbo checks with SKIP_ENV_VALIDATION=1 and returns pass/fail plus the last 80 lines. 'test' needs TEST_DATABASE_URL on a local scratch database in this server's env; it is refused otherwise.",
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
      const r = await runChecks(tasks, force ?? false);
      return text(`${r.ok ? "PASS" : "FAIL"}\n${r.output}`, !r.ok);
    },
  );

  server.registerTool(
    "buzz_deploy_status",
    {
      description:
        "Latest main commit, its GitHub Vercel status, and the live site footer version. Does not call /api/health or any database route.",
    },
    guarded(() => deployStatus()),
  );

  return server;
}
