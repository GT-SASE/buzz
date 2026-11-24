import { describe, expect, it } from "bun:test";

import { formatBotCommands } from "../packages/mcp/src/bot";
import { formatBotDatabase } from "../packages/mcp/src/bot-db";
import { listProcedures } from "../packages/mcp/src/procedures";
import { formatRoutes, listRoutes } from "../packages/mcp/src/routes";
import { describeSchema } from "../packages/mcp/src/schema";

describe("mcp introspection", () => {
  it("parses tRPC procedures", () => {
    const all = listProcedures();
    const create = all.find((p) => p.path === "page.create");
    expect(create).toMatchObject({ access: "admin", kind: "mutation" });
    expect(create?.line).toBeGreaterThan(0);
    expect(
      all.some((p) => p.access === "protected" && p.kind === "query"),
    ).toBe(true);
  });

  it("describes the pages table with its slug column", async () => {
    const out = await describeSchema("page");
    expect(out).toContain("buzz_page");
    expect(out).toMatch(/\n {2}slug {2}varchar\(60\)/);
  });

  it("lists routes with route groups stripped", () => {
    const routes = listRoutes();
    expect(routes.find((r) => r.url === "/portal/admin/pages")?.tag).toBe(
      "portal admin",
    );
    expect(routes.find((r) => r.url === "/[slug]")?.tag).toBe("marketing");
    expect(routes.some((r) => r.url.includes("("))).toBe(false);
  });
});

describe("mcp bot introspection", () => {
  it("applies the real bot migrations to PGlite and describes them", async () => {
    const out = await formatBotDatabase();
    for (const t of ["events", "tasks", "event_steps"]) {
      expect(out).toContain(`table discord_bot.${t}\n`);
    }
    // Columns, types, nullability and defaults come from the catalogs.
    expect(out).toMatch(/\n {2}guild_id {2}discord_bot\.discord_id {2}notNull/);
    expect(out).toMatch(
      /\n {2}status {2}discord_bot\.event_status {2}notNull default 'active'/,
    );
    // A later migration's column and enum values, in sort order.
    expect(out).toContain("not_needed_at  timestamp with time zone");
    expect(out).toMatch(
      /enum discord_bot\.event_step_kind: .*engage_picture, budget_approved, slides/,
    );
    expect(out).toContain("domain discord_bot.discord_id: text");
    expect(out).toContain("table discord_bot.row_versions");
    expect(out).toContain("-- schema discord_bot --");
    expect(out).toContain(
      "CONSTRAINT event_steps_pkey: PRIMARY KEY (event_id, kind)",
    );
    expect(out).toMatch(/INDEX events_live_thread_uq|events_live_thread_uq/);
    // Functions carry their argument list and SECURITY DEFINER flag. Only the triggers
    // are left in the database; the writes are TypeScript.
    const recorder = out
      .split("\n")
      .filter((l) => l.startsWith("function discord_bot.record_row_version("));
    expect(recorder).toHaveLength(1);
    expect(recorder[0]).toContain("returns trigger");
    expect(recorder[0]).toContain("security definer");
    expect(out).not.toContain("function discord_bot.assign_event_step(");
  }, 60_000);

  it("filters bot objects by name and keeps the schema heading", async () => {
    const out = await formatBotDatabase("event_steps");
    expect(out).toStartWith("-- schema discord_bot --");
    expect(out).toContain("table discord_bot.event_steps");
    expect(out).not.toContain("table discord_bot.tasks");
    expect(await formatBotDatabase("zzz-none")).toBe(
      "No matching bot database objects.",
    );
  });

  it("filters buzz from bot in describeSchema", async () => {
    const buzz = await describeSchema("page", "buzz");
    expect(buzz).toContain("buzz_page");
    expect(buzz).not.toContain("bot database");
    const bot = await describeSchema("event_steps", "bot");
    expect(bot).toContain("table discord_bot.event_steps");
    expect(bot).not.toContain("buzz_page");
    const all = await describeSchema("event");
    expect(all).toContain("=== buzz database");
    expect(all).toContain("=== bot database");
  });

  it("lists bot functions and crons from deployment.ts", async () => {
    const out = await formatRoutes();
    expect(out).toContain("/api/interactions  [bot function]");
    expect(out).toContain("/api/cron/reminders  [bot cron]");
    expect(out).toContain("/portal/admin/pages  [portal admin]");
  });

  it("lists slash commands, subcommands and options", async () => {
    const out = await formatBotCommands();
    expect(out).toContain("/event");
    expect(out).toMatch(/\n {2}create {2}\(subcommand\)/);
    expect(out).toMatch(/\n {4}name: string {2}required/);
    expect(await formatBotCommands("zzz-none")).toBe("No matching commands.");
  });
});
