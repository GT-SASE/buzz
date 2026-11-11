import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";

const CONFIG_URL = pathToFileURL(
  join(import.meta.dirname, "..", "..", "eslint.config.js"),
).href;

const OUTSIDE = "src/discord/handler.ts";

describe("database lint rules", () => {
  let linter: Linter;
  let blocks: Linter.Config[];

  beforeAll(async () => {
    const loaded = (await import(CONFIG_URL)) as { default: Linter.Config[] };
    blocks = loaded.default.filter((block) => block.name?.startsWith("db/"));
    linter = new Linter();
    expect(blocks).toHaveLength(2);
  });

  const problems = (code: string, filename = "src/db/sample.ts") =>
    linter
      .verify(
        code,
        [
          {
            files: ["**/*.ts"],
            languageOptions: { parser: tseslint.parser },
          },
          ...blocks,
        ],
        { filename },
      )
      .map((problem) => problem.message);

  const refused = (code: string, filename?: string) => {
    expect(problems(code, filename).length).toBeGreaterThan(0);
  };

  describe("inside src/db", () => {
    it.each([
      "or",
      "match",
      "order",
      "select",
      "from",
      "textSearch",
      "rpc",
      "eq",
      "neq",
      "is",
      "lte",
    ])("refuses a variable as the first argument of .%s()", (method) => {
      refused(`db.${method}(userInput, {});`);
    });

    it.each(["or", "order", "select", "from", "textSearch", "eq"])(
      "refuses a template as the first argument of .%s()",
      (method) => {
        refused(`db.${method}(\`name.ilike.\${term}\`);`);
      },
    );

    it("refuses an object passed to .match()", () => {
      refused(`q.match({ id });`);
    });

    it.each([
      "filter",
      "not",
      "upsert",
      "delete",
      "schema",
      "setHeader",
      "explain",
      "ilikeAnyOf",
      "ilikeAllOf",
      "likeAnyOf",
      "likeAllOf",
      "regexMatch",
      "regexIMatch",
      "notIn",
      "isDistinct",
      "throwOnError",
      "rollback",
      "csv",
      "geojson",
      "abortSignal",
      "returns",
      "overrideTypes",
      "range",
      "rangeGt",
      "rangeGte",
      "rangeLt",
      "rangeLte",
      "rangeAdjacent",
    ])("refuses .%s() even with literal arguments", (method) => {
      refused(`q.${method}("name", "eq", "x");`);
    });

    it("refuses selecting every column, and a call with no columns", () => {
      refused(`q.select("*");`);
      refused(`q.select("id,events(*)");`);
      refused(`q.select();`);
    });

    it("refuses .in() values that skip a validator", () => {
      refused(`q.in("id", ids);`);
      refused(`q.in("id", ["a"]);`);
      refused(`q.in("id", clean(ids));`);
    });

    it("accepts .in() values from a validator", () => {
      expect(problems(`q.in("id", snowflakeList(ids));`)).toEqual([]);
      expect(problems(`q.in("id", uuidList(ids));`)).toEqual([]);
    });

    it("refuses a search pattern not built by the helper", () => {
      refused("q.ilike('name', `%${term}%`);");
      expect(problems(`q.ilike("name", searchPattern(term));`)).toEqual([]);
    });

    it("lets .or() take only a literal or the page helper", () => {
      refused(`q.or(term);`);
      refused(`q.or(helper(term));`);
      expect(problems(`q.or("a.eq.1");`)).toEqual([]);
      expect(problems(`q.or(keysetAfter(date, id));`)).toEqual([]);
    });

    it("refuses spread, computed keys or a variable in RPC arguments and writes", () => {
      refused(`db.rpc("claim_reminder", { ...input });`);
      refused(`db.rpc("claim_reminder", { [name]: value });`);
      refused(`db.rpc("claim_reminder", input);`);
      refused(`q.update({ ...input });`);
      refused(`q.update({ [column]: value });`);
      refused(`q.update(input);`);
      refused(`q.insert({ [column]: value });`);
      refused(`q.insert(input);`);
    });

    it("accepts literal RPC arguments and writes", () => {
      expect(problems(`db.rpc("claim_reminder", { p_task_id: id });`)).toEqual(
        [],
      );
      expect(problems(`q.update({ name });`)).toEqual([]);
    });

    it("refuses a method called through a computed key", () => {
      refused(`q["or"](x);`);
      refused(`q[name](x);`);
    });

    it("refuses reaching into a query's URL or headers", () => {
      refused(`q.url.searchParams.append("a", "b");`);
      refused(`q.headers.set("Prefer", "x");`);
      refused(`const u = q?.url;`);
    });

    it("does not honour inline disable comments", () => {
      refused(`// eslint-disable-next-line no-restricted-syntax\nq.or(term);`);
    });

    it("allows Supabase imports", () => {
      expect(
        problems(`import { PostgrestClient } from "@supabase/postgrest-js";`),
      ).toEqual([]);
    });
  });

  describe("outside src/db", () => {
    it("refuses Supabase packages, however they are loaded", () => {
      refused(
        `import { PostgrestClient } from "@supabase/postgrest-js";`,
        OUTSIDE,
      );
      refused(`const m = await import("@supabase/supabase-js");`, "api/x.ts");
      refused(`const m = require("@supabase/supabase-js");`, "api/x.ts");
    });

    it.each(["../db/internal.ts", "../../src/db/internal"])(
      "refuses importing the query client through %s",
      (path) => {
        refused(`import { rest } from "${path}";`, OUTSIDE);
      },
    );

    it("allows importing the opaque client and the functions", () => {
      expect(
        problems(`import { getDb } from "../db/client.ts";`, OUTSIDE),
      ).toEqual([]);
    });

    it.each([
      "guild_config",
      "managed_channels",
      "events",
      "tasks",
      "reminder_log",
      "job_runs",
      "config_audit",
      "interaction_claims",
      "task_reassignments",
    ])("refuses .from() on the table %s", (table) => {
      refused(`db.from("${table}");`, OUTSIDE);
    });

    it.each([
      `db.rpc("claim_reminder", {});`,
      `q.or("a.eq.1");`,
      `q.textSearch("a", "b");`,
      `q.ilike("a", "b");`,
      `q.update({ name });`,
      `q.update(input);`,
      `q.insert({ name });`,
      `q.upsert({ name });`,
      `q.delete();`,
      `q.delete({ count: "exact" });`,
    ])("refuses %s", (code) => {
      refused(code, OUTSIDE);
    });

    it("leaves ordinary array, map, string and hash methods alone", () => {
      expect(
        problems(
          `list.filter(fn); text.match(re); Array.from(set); map.delete(key);
           headers.delete("x"); createHash("sha256").update(body);
           createHmac("sha256", secret).update(body);`,
          OUTSIDE,
        ),
      ).toEqual([]);
    });
  });
});
