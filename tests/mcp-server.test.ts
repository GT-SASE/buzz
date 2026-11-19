import { describe, expect, it } from "bun:test";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { appBuild } from "../sites/web/build-version";

const root = path.resolve(import.meta.dirname, "..");

describe("buzz mcp server over stdio", () => {
  it("lists tools and answers read-only calls", async () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== "DATABASE_URL") env[k] = v;
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
      expect(serverVersion).toBe(appBuild().version);

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
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
    } finally {
      await client.close();
    }
  }, 30_000);
});
