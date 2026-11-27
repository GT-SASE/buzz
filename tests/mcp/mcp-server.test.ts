import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { appBuild } from "../../sites/web/build-version";

const root = path.resolve(import.meta.dirname, "../..");

describe("buzz mcp server over stdio", () => {
  it("lists tools and answers read-only calls", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      // The refusal check below needs no scratch DB in the server's env.
      if (
        v !== undefined &&
        ![
          "DATABASE_URL",
          "TEST_DATABASE_URL",
          "CONCURRENCY_DATABASE_URL",
        ].includes(k)
      ) {
        env[k] = v;
      }
    }
    // Shallow clones (GitHub CI): server returns MAJOR.MINOR.0 instead of the computed build.
    const webDir = path.join(root, "sites/web");
    const shallow = execFileSync(
      "git",
      ["rev-parse", "--is-shallow-repository"],
      {
        cwd: webDir,
        encoding: "utf8",
      },
    ).trim();
    let expected: string;
    if (shallow === "true") {
      const pkg = JSON.parse(
        readFileSync(path.join(webDir, "package.json"), "utf8"),
      ) as { version: string };
      const [major, minor] = pkg.version.split(".");
      expected = `${major}.${minor}.0`;
    } else {
      expected = appBuild().version;
    }
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: ["packages/mcp/src/index.ts"],
        cwd: root,
        env,
      }),
    );
    try {
      const serverVersion = client.getServerVersion()?.version;
      expect(serverVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(serverVersion).toBe(expected);

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "buzz_bot_commands",
        "buzz_db_schema",
        "buzz_deploy_status",
        "buzz_guide",
        "buzz_migrations",
        "buzz_routes",
        "buzz_run_checks",
        "buzz_trpc_procedures",
        "buzz_version",
      ]);

      const procs = await client.callTool({
        name: "buzz_trpc_procedures",
        arguments: { filter: "page" },
      });
      expect(procs.isError).toBeFalsy();
      expect(JSON.stringify(procs.content)).toContain("page.create");

      const mig = await client.callTool({
        name: "buzz_migrations",
        arguments: {},
      });
      expect(mig.isError).toBeFalsy();
      expect(JSON.stringify(mig.content)).toContain("0011_page.sql");
      expect(JSON.stringify(mig.content)).toContain(
        "sites/discord-bot/db/drizzle/0000_baseline.sql",
      );

      const text = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await client.callTool({ name, arguments: args });
        expect(r.isError).toBeFalsy();
        return JSON.stringify(r.content);
      };
      expect(await text("buzz_guide")).toContain("buzz_bot_commands");
      expect(await text("buzz_db_schema", { database: "bot" })).toContain(
        "table discord_bot.events",
      );
      expect(
        await text("buzz_db_schema", { table: "page", database: "buzz" }),
      ).toContain("buzz_page");
      expect(await text("buzz_routes")).toContain(
        "/api/cron/discord-reminders  [api]",
      );
      expect(await text("buzz_bot_commands", { filter: "event" })).toContain(
        "/event",
      );
      expect(await text("buzz_version")).toContain("@buzz/discord-bot");

      // The bot tasks are guarded: without a scratch DB the call is refused.
      const refused = await client.callTool({
        name: "buzz_run_checks",
        arguments: { tasks: ["bot:test:db:concurrency"] },
      });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("Refused");
    } finally {
      await client.close();
    }
  }, 30_000);
});
