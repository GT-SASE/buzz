import { describe, expect, it } from "bun:test";

import { formatBotCommands } from "../packages/mcp/src/bot";
import { parseBotSql, readBotDatabase } from "../packages/mcp/src/bot-sql";
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
  it("replays the real bot migrations", () => {
    const db = readBotDatabase();
    const steps = db.tables.find(
      (t) => t.name === "event_steps" && t.schema === "public",
    );
    // Added by a later migration than the baseline.
    expect(steps?.columns.map((c) => c.name)).toContain("not_needed_at");
    const kind = db.enums.find((e) => e.name === "event_step_kind");
    expect(kind?.values).toContain("slides");
    expect(
      db.functions.filter((f) => f.name === "assign_event_step"),
    ).toHaveLength(1);
    expect(db.domains.map((d) => d.name)).toContain("discord_id");
  });

  it("labels objects with the schema the SQL declares", () => {
    const db = parseBotSql([
      {
        name: "1_a.sql",
        sql: `-- migrate:up
-- it's a comment with an apostrophe
CREATE SCHEMA discord_bot;
SET LOCAL search_path TO discord_bot;
CREATE TYPE kind AS ENUM ('a', 'c');
CREATE TABLE things (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  note text DEFAULT 'x;y',
  CONSTRAINT things_pkey PRIMARY KEY (id)
);
CREATE FUNCTION touch(p_id uuid, p_k kind) RETURNS boolean
  LANGUAGE sql AS $$ SELECT 1; SELECT 2; $$;
-- migrate:down
DROP TABLE things;`,
      },
      {
        name: "2_b.sql",
        sql: `-- migrate:up
ALTER TYPE discord_bot.kind ADD VALUE 'b' AFTER 'a';
ALTER TABLE discord_bot.things ADD COLUMN extra integer NOT NULL, DROP COLUMN note;
DROP FUNCTION discord_bot.touch(uuid, discord_bot.kind);
CREATE FUNCTION discord_bot.touch(p_id uuid) RETURNS text LANGUAGE sql AS $$ SELECT 'x' $$;`,
      },
    ]);
    expect(db.schemas).toContain("discord_bot");
    expect(db.enums).toEqual([
      { schema: "discord_bot", name: "kind", values: ["a", "b", "c"] },
    ]);
    const things = db.tables[0]!;
    expect(things.schema).toBe("discord_bot");
    expect(things.columns.map((c) => c.name)).toEqual(["id", "extra"]);
    expect(things.constraints).toEqual(["PK things_pkey: (id)"]);
    expect(db.functions).toHaveLength(1);
    expect(db.functions[0]).toMatchObject({
      schema: "discord_bot",
      name: "touch",
      args: "p_id uuid",
      returns: "text",
    });
  });

  it("filters buzz from bot in describeSchema", async () => {
    const buzz = await describeSchema("page", "buzz");
    expect(buzz).toContain("buzz_page");
    expect(buzz).not.toContain("bot database");
    const bot = await describeSchema("event_steps", "bot");
    expect(bot).toContain("table public.event_steps");
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
