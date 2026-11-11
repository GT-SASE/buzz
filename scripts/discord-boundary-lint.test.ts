import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedGitEnv } from "../test/support/git-env.ts";
import { discordBoundary } from "./discord-boundary-lint.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/check-discord-urls.sh");
const OUTSIDE_CLIENT = "src/commands/example.ts";

// Runs only the boundary rules, which need no type information, so that a
// sample does not have to exist on disk.
const boundaryOnly = new ESLint({
  cwd: REPO_ROOT,
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx,js,jsx}"],
      languageOptions: { parser: tseslint.parser },
    },
    ...discordBoundary,
  ],
});

async function ruleIds(code: string, filePath = OUTSIDE_CLIENT) {
  const [result] = await boundaryOnly.lintText(code, { filePath });
  return result?.messages.map((message) => message.ruleId);
}

async function expectRefused(code: string, filePath = OUTSIDE_CLIENT) {
  const ids = await ruleIds(code, filePath);

  expect(ids?.some((id) => id?.startsWith("no-restricted-"))).toBe(true);
}

describe("discord boundary rules", () => {
  const direct = 'await fetch("https://discord.com/api/v10");';

  it.each([
    [
      "a fetch to the API",
      'await fetch("https://discord.com/api/v10/channels/1/messages");',
    ],
    ["a fetch to any URL", "await fetch(url);"],
    ["fetch passed around as a value", "const send = fetch;"],
    ["globalThis", 'await globalThis.fetch("https://a.test");'],
    ["globalThis by computed name", 'await globalThis["fetch"]("x");'],
    ["globalThis with an assembled name", 'globalThis["fe" + "tch"]("x");'],
    ["global", 'await global.fetch("https://a.test");'],
    ["window", 'await window.fetch("https://a.test");'],
    ["self", 'await self.fetch("https://a.test");'],
    ["XMLHttpRequest", "new XMLHttpRequest();"],
    ["WebSocket", 'new WebSocket("wss://a.test");'],
    ["EventSource", 'new EventSource("https://a.test");'],
    ["an API URL in a string", 'const url = "https://discord.com/api/v10";'],
    ["the older API host", 'const url = "https://discordapp.com/api";'],
    ["the host in another case", 'const url = "https://DISCORD.com/api";'],
    ["the host alone", 'const host = "https://discord.com";'],
    ["a canary subdomain", 'const url = "https://canary.discord.com/api";'],
    ["an invite host", 'const url = "https://discord.gg/abc";'],
    [
      "an API URL in a template",
      "const url = `https://discord.com/api/v10/channels/${id}`;",
    ],
    ["an API path alone", "const path = `/api/v10/channels/${id}`;"],
    ["a channels route", 'const path = "/channels/1/messages";'],
    ["a channels route in a template", "const path = `/channels/${id}`;"],
    ["a webhooks route", "const path = `/webhooks/${id}/${token}`;"],
    ["an interactions route", "const path = `/interactions/${id}/callback`;"],
    ["node:http", 'import http from "node:http";'],
    ["http", 'import http from "http";'],
    ["node:https", 'import { request } from "node:https";'],
    ["node:http2", 'import { connect } from "node:http2";'],
    ["node:net", 'import { connect } from "node:net";'],
    ["tls", 'import { connect } from "tls";'],
    ["dgram", 'import dgram from "node:dgram";'],
    ["axios", 'import axios from "axios";'],
    ["got", 'import got from "got";'],
    ["ky", 'import ky from "ky";'],
    ["node-fetch", 'import fetcher from "node-fetch";'],
    ["superagent", 'import agent from "superagent";'],
    ["undici", 'import { request } from "undici";'],
    ["an undici subpath", 'import x from "undici/lib/core";'],
    ["a re-export", 'export { request } from "undici";'],
    ["discord.js", 'import { REST } from "discord.js";'],
    ["a Discord library", 'import { REST } from "@discordjs/rest";'],
    ["another discord package", 'import x from "discord-interactions";'],
    [
      "the API's URL constant",
      'import { RouteBases } from "discord-api-types/v10";',
    ],
    ["the API's routes", 'import { Routes } from "discord-api-types/v10";'],
    ["a test file", 'import { helper } from "./helper.test.ts";'],
    ["a test file by dynamic import", 'await import("./helper.test.ts");'],
    ["a test helper", 'import { x } from "../../test/support/helper.ts";'],
    ["a test helper as a type", 'import type { X } from "../test/x.ts";'],
    ["a re-export of a test helper", 'export { x } from "../test/x.ts";'],
    ["a test helper by dynamic import", 'await import("../../test/x.ts");'],
    ["a literal dynamic import", 'await import("node:https");'],
    ["an assembled dynamic import", 'await import("node:" + name);'],
    ["a template dynamic import", "await import(`node:${name}`);"],
    ["require", 'const https = require("https");'],
    ["createRequire", 'import { createRequire } from "node:module";'],
    ["getBuiltinModule", 'process.getBuiltinModule("node:https");'],
    ["Reflect.get", "Reflect.get(target, name);"],
    ["Reflect.get by computed name", 'Reflect["get"](target, name);'],
    ["eval", 'eval("fe" + "tch");'],
    ["indirect eval", 'const run = eval;\nrun("x");'],
    ["Function", 'Function("return 1")();'],
    ["new Function", 'new Function("return 1")();'],
    ["the constructor trick", 'run.constructor("return 1")();'],
    ["the computed constructor trick", 'run["constructor"]("return 1")();'],
    ["node:vm", 'import { runInThisContext } from "node:vm";'],
    ["vm", 'import vm from "vm";'],
    ["node:vm by dynamic import", 'await import("node:vm");'],
  ])("refuses %s", async (_label, code) => {
    await expectRefused(code);
  });

  it.each([
    ["src", "src/tool.ts"],
    ["api", "api/tool.ts"],
    ["the interactions endpoint", "api/interactions.ts"],
  ])("refuses child_process in %s", async (_label, filePath) => {
    await expectRefused(
      'import { spawn } from "node:child_process";',
      filePath,
    );
    await expectRefused('import { spawn } from "child_process";', filePath);
    await expectRefused('await import("node:child_process");', filePath);
  });

  it.each(["src/handlers/x.ts", "api/interactions.ts", "scripts/tool.ts"])(
    "refuses test/ from %s",
    async (filePath) => {
      await expectRefused(
        'import { x } from "../test/support/x.ts";',
        filePath,
      );
    },
  );

  it.each(["scripts/prepare-backup-db.ts", "scripts/prepare-postgrest-db.ts"])(
    "lets %s reuse the migration harness, and opens nothing else",
    async (filePath) => {
      const code = 'import { x } from "../test/db/harness.ts";';

      expect(await ruleIds(code, filePath)).toEqual([]);
      await expectRefused(direct, filePath);
      await expectRefused('import { x } from "./helper.test.ts";', filePath);
    },
  );

  it("does not take a name that ends in test for test/", async () => {
    expect(await ruleIds('import { x } from "vitest/config";')).toEqual([]);
    expect(await ruleIds('import { x } from "./latest/x.ts";')).toEqual([]);
  });

  it("allows child_process in scripts", async () => {
    const code = 'import { spawn } from "node:child_process";';

    expect(await ruleIds(code, "scripts/tool.ts")).toEqual([]);
  });

  it.each([
    ["a local function named fetch", "function fetch() {}\nfetch();"],
    ["a local variable named self", "const self = 1;\nexport { self };"],
    ["a method named fetch", "await rows.fetch();"],
    ["another URL", 'const url = "https://example.com/api/items";'],
    ["this app's own endpoint", 'const path = "/api/interactions";'],
    ["a mention in a comment", "// See https://discord.com/api/v10 for this."],
    ["the word Discord", 'const text = "Sent from Discord";'],
    ["a relative import", 'import { x } from "./channels/example.ts";'],
    ["a literal dynamic import", 'await import("./example.ts");'],
    ["other Reflect methods", "Reflect.ownKeys(target);"],
    [
      "the API's types and constants",
      'import { InteractionType, type APIUser } from "discord-api-types/v10";',
    ],
    ["the outbound builders", 'import { x } from "./discord/outbound.ts";'],
    [
      "the type of a verified interaction",
      'import type { VerifiedInteraction } from "./verified-interaction.ts";',
    ],
  ])("allows %s", async (_label, code) => {
    expect(await ruleIds(code)).toEqual([]);
  });

  it("refuses Response.json outside the endpoint file", async () => {
    await expectRefused(
      "return Response.json({ type: 4, data: { content: x } });",
    );
  });

  it("refuses new Response outside the endpoint file", async () => {
    await expectRefused(
      "return new Response(body);",
      "src/discord/commands.ts",
    );
    await expectRefused("return new Response(body);", "api/cron.ts");
    await expectRefused("return new Response(body);", "scripts/tool.ts");
  });

  it.each(["api/interactions.ts", "api/cron/reminders.ts"])(
    "allows new Response in %s, but not Response.json",
    async (filePath) => {
      expect(await ruleIds('return new Response("no");', filePath)).toEqual([]);
      await expectRefused("return Response.json(x);", filePath);
      await expectRefused('Response["json"](x);', filePath);
    },
  );

  it("allows Response as a type", async () => {
    expect(
      await ruleIds(
        "export function f(r: Response): Request | Response { return r; }",
      ),
    ).toEqual([]);
  });

  it.each([
    ["nick", "const name = member.nick;"],
    ["nick by optional chain", "const name = member?.nick;"],
    ["nick by computed name", 'const name = member["nick"];'],
    ["username", "const name = member.user.username;"],
    ["global_name", "const name = user.global_name;"],
    ["display_name", "const name = user.display_name;"],
    ["discriminator", "const name = user.discriminator;"],
    ["a destructured nick", "const { nick } = member;"],
    ["a destructured username", "const { username: name } = user;"],
  ])("refuses reading a member name through %s", async (_label, code) => {
    await expectRefused(code);
    await expectRefused(code, "api/interactions.ts");
    await expectRefused(code, "src/discord/client2.ts");
  });

  it.each([
    ["a field name in a string", 'read(member, "nick");'],
    ["a field name in a template", "read(member, `username`);"],
    ["a quoted object key", 'const fields = { "global_name": 1 };'],
  ])("refuses a member name through %s", async (_label, code) => {
    await expectRefused(code);
  });

  it("refuses JSON built inside a Response in the endpoint file", async () => {
    await expectRefused(
      "return new Response(JSON.stringify(x));",
      "api/interactions.ts",
    );
    expect(
      await ruleIds(
        "return new Response(serializeDirectResponse(x));",
        "api/interactions.ts",
      ),
    ).toEqual([]);
  });

  it.each([
    ["navigator", "navigator.sendBeacon(url);"],
    ["ofetch", 'import { ofetch } from "ofetch";'],
    ["eris", 'import Eris from "eris";'],
    ["calling safe directly", "safe(parts, value);"],
    ["calling plain directly", "plain(parts);"],
    ["a user mention around a value", "safe`<@${id}>`;"],
    ["a role mention around a value", "safe`hi <@&${id}>`;"],
    ["a channel mention around a value", "safe`<#${id}>`;"],
    ["a command around a value", "safe`</${id}>`;"],
    ["an open bracket before a value", "safe`<${id}`;"],
  ])("refuses %s", async (_label, code) => {
    await expectRefused(code);
  });

  it("allows safe as a tag with ordinary values", async () => {
    expect(
      await ruleIds("safe`Due: ${escapeUserText(x)} for ${userMention(id)}`;"),
    ).toEqual([]);
  });

  it("allows mention syntax with no value after it, as source text", async () => {
    expect(await ruleIds("safe`a <b> c`;")).toEqual([]);
  });

  it.each(["src/a.test.helper.ts", "src/a.test.json.ts", "src/a.testing.ts"])(
    "does not exempt %s",
    async (filePath) => {
      await expectRefused(direct, filePath);
    },
  );

  it("allows other uses of those words", async () => {
    expect(await ruleIds('const label = "Enter a username";')).toEqual([]);
    expect(await ruleIds("const label = `the nick here`;")).toEqual([]);
    expect(await ruleIds("const nick = 1;\nexport { nick };")).toEqual([]);
  });

  it("allows direct calls in the client", async () => {
    expect(await ruleIds(direct, "src/discord/client.ts")).toEqual([]);
  });

  it("exempts only the command registration script", async () => {
    const routes = 'import { Routes } from "discord-api-types/v10";';

    expect(await ruleIds(direct, "scripts/register-commands.ts")).toEqual([]);
    expect(await ruleIds(routes, "scripts/register-commands.ts")).toEqual([]);
    await expectRefused(direct, "scripts/register-other.ts");
    await expectRefused(direct, "src/register-commands.ts");
    await expectRefused(routes, "scripts/tool.ts");
  });

  it.each([
    "src/commands/example.test.ts",
    "src/commands/example.test.tsx",
    "test/support/helper.ts",
  ])("allows Discord URLs in %s", async (filePath) => {
    expect(await ruleIds(direct, filePath)).toEqual([]);
  });

  it.each([
    "api/interactions.ts",
    "src/discord/verify.ts",
    "scripts/tool.ts",
    "src/view.tsx",
    "src/view.jsx",
    "scripts/view.tsx",
    "scripts/view.jsx",
    "src/tool.js",
  ])("applies to %s", async (filePath) => {
    await expectRefused(direct, filePath);
  });

  it.each([
    ["the next line", "// eslint-disable-next-line\nawait fetch(url);"],
    [
      "the named rule",
      "// eslint-disable-next-line no-restricted-globals\nawait fetch(url);",
    ],
    ["the whole file", "/* eslint-disable */\nawait fetch(url);"],
  ])("cannot be turned off inline for %s", async (_label, code) => {
    await expectRefused(code);
  });
});

describe("the database client", () => {
  const filePath = "src/db/client.ts";

  it("may use fetch", async () => {
    expect(await ruleIds("await fetch(url);", filePath)).toEqual([]);
  });

  it("may not name Discord or read a member name", async () => {
    await expectRefused('await fetch("https://discord.com/api");', filePath);
    await expectRefused("user.nick;", filePath);
  });
});

describe("the repository's ESLint config", () => {
  const repoConfig = new ESLint({ cwd: REPO_ROOT });

  async function configFor(filePath: string) {
    const config = (await repoConfig.calculateConfigForFile(filePath)) as {
      rules: Record<string, unknown[]>;
      linterOptions: { noInlineConfig?: boolean };
    };
    return {
      restricted: Object.keys(config.rules)
        .filter(
          (rule) =>
            rule.startsWith("no-restricted-") && config.rules[rule]?.[0] !== 0,
        )
        .sort(),
      noInlineConfig: config.linterOptions.noInlineConfig,
    };
  }

  it("turns the rules on outside the client", async () => {
    expect(await configFor(OUTSIDE_CLIENT)).toEqual({
      restricted: [
        "no-restricted-globals",
        "no-restricted-imports",
        "no-restricted-syntax",
      ],
      noInlineConfig: true,
    });
  });

  it.each([
    "src/discord/client.ts",
    "scripts/register-commands.ts",
    "src/commands/example.test.ts",
  ])("leaves them off for %s", async (filePath) => {
    const { restricted } = await configFor(filePath);

    expect(restricted).toEqual([]);
  });
});

describe("the database lint blocks", () => {
  const repoConfig = new ESLint({ cwd: REPO_ROOT });

  async function rulesFor(filePath: string) {
    const config = (await repoConfig.calculateConfigForFile(filePath)) as {
      rules: Record<string, unknown[]>;
    };
    return config.rules;
  }

  const EXTENSIONS = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];

  it.each(EXTENSIONS)("keep Supabase out of a .%s file", async (extension) => {
    const rules = await rulesFor(`src/handlers/x.${extension}`);

    expect(JSON.stringify(rules["db/imports"])).toContain("@supabase/*");
    expect(JSON.stringify(rules["db/syntax"])).toContain(
      "Database queries belong in src/db/.",
    );
  });

  it.each(EXTENSIONS)(
    "hold a .%s file in src/db to the query rules",
    async (extension) => {
      const rules = await rulesFor(`src/db/x.${extension}`);

      expect(JSON.stringify(rules["db/syntax"])).toContain(
        "Tables, columns, functions and filters must be string literals.",
      );
    },
  );

  it.each(["ts", "mts", "js", "mjs"])(
    "leave a .%s test in src/db alone",
    async (extension) => {
      const rules = await rulesFor(`src/db/x.test.${extension}`);

      expect(rules["db/syntax"]).toBeUndefined();
    },
  );
});

describe("check-discord-urls.sh", () => {
  const env = isolatedGitEnv();
  let repo: string;

  function run(files: Record<string, string>) {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      spawnSync("git", ["add", path], { cwd: repo, env });
    }
    return spawnSync("bash", [SCRIPT], { cwd: repo, env, encoding: "utf8" });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "check-discord-urls-"));
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("passes the repository itself", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });

    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails outside a repository, rather than passing unchecked", () => {
    const result = spawnSync("bash", [SCRIPT], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
  });

  it("works through the file kinds and exclusions in one repository", () => {
    spawnSync("git", ["init", "-q"], { cwd: repo, env });

    expect(
      run({
        "src/discord/client.ts": 'const a = "https://discord.com/api";\n',
        "src/discord/client.test.ts": 'const a = "https://discord.gg/x";\n',
        "scripts/test-rules.sh": "echo https://discord.com/api\n",
        "README.md": "Talks to Discord.\n",
      }).status,
    ).toBe(0);

    for (const [path, content] of [
      ["scripts/send.sh", "curl https://discord.com/api/v10/channels\n"],
      [".github/workflows/notify.yml", "url: https://discordapp.com/api\n"],
      ["docs/invite.md", "Join at https://discord.gg/example\n"],
      ["scripts/run.test.sh", "curl https://discord.com/api\n"],
      ["src/helper.test.txt", "https://discord.com/api\n"],
    ] as const) {
      const result = run({ [path]: content });

      expect(result.status, path).toBe(1);
      expect(result.stdout, path).toContain(path);
      spawnSync("git", ["rm", "-qf", path], { cwd: repo, env });
    }

    expect(run({}).status).toBe(0);
  });
});
