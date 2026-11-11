import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isolatedGitEnv } from "../test/support/git-env.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts/check-deploy-settings.sh");

// An npm script passes its settings down as these, and they outrank .npmrc.
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(isolatedGitEnv()).filter(
      ([name]) => !name.toLowerCase().startsWith("npm_config_"),
    ),
  );
}

const GOOD_VERCEL = {
  git: { deploymentEnabled: { "**": false, main: true, staging: true } },
};

describe("check-deploy-settings.sh", () => {
  const env = cleanEnv();
  let repo: string;

  function write(path: string, content: string) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    spawnSync("git", ["add", path], { cwd: repo, env });
  }

  function run(extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync("bash", [SCRIPT], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "check-deploy-settings-"));
    spawnSync("git", ["init", "-q"], { cwd: repo, env });
    write("package.json", '{ "name": "example", "private": true }\n');
    write("package-lock.json", "{}\n");
    write(".npmrc", "ignore-scripts=true\n");
    write("vercel.json", JSON.stringify(GOOD_VERCEL));
  });

  afterEach(() => {
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

  it("passes the expected settings", () => {
    const result = run();

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

  it.each([
    [
      "a later line that turns scripts back on",
      "ignore-scripts=true\nignore-scripts=false\n",
    ],
    [
      "another registry",
      "ignore-scripts=true\nregistry=https://example.test/\n",
    ],
    ["scripts on", "ignore-scripts=false\n"],
    ["an empty file", ""],
  ])("refuses .npmrc with %s", (_label, content) => {
    write(".npmrc", content);

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".npmrc must hold only");
  });

  it("refuses a missing .npmrc", () => {
    rmSync(join(repo, ".npmrc"));

    expect(run().status).toBe(1);
  });

  it("asks npm as well as reading the file", () => {
    const result = run({ npm_config_ignore_scripts: "false" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm config get ignore-scripts");
  });

  it.each([
    "api/package.json",
    "src/deep/package.json",
    "api/.npmrc",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
    "deno.lock",
    ".yarnrc",
    ".yarnrc.yml",
    "bunfig.toml",
    "api/package-lock.json",
    "api/\u00e9/package.json",
  ])("refuses a tracked %s", (path) => {
    write(path, "{}\n");

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path);
  });

  it("does not take a similar name for a package file", () => {
    write("docs/package.json.md", "text\n");
    write("src/my-package.json", "{}\n");

    expect(run().status).toBe(0);
  });

  it.each([
    ["previews on", { "**": true, main: true, staging: true }],
    ["staging off", { "**": false, main: true }],
    ["main off", { "**": false, main: false, staging: true }],
    [
      "another branch on",
      { "**": false, main: true, staging: true, dev: true },
    ],
    ["the rule that misses a slash", { "*": false, main: true, staging: true }],
  ])("refuses deployment settings with %s", (_label, deploymentEnabled) => {
    write("vercel.json", JSON.stringify({ git: { deploymentEnabled } }));

    const result = run();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deploy main and staging");
  });

  it.each(["buildCommand", "installCommand", "ignoreCommand", "devCommand"])(
    "refuses %s in vercel.json",
    (name) => {
      write(
        "vercel.json",
        JSON.stringify({ ...GOOD_VERCEL, [name]: "npm run anything" }),
      );

      const result = run();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not set a command");
    },
  );

  it("refuses vercel.json with no deployment settings", () => {
    write("vercel.json", "{}\n");

    expect(run().status).toBe(1);
  });
});

describe("the workflows", () => {
  function workflow(name: string) {
    return readFileSync(join(REPO_ROOT, ".github/workflows", name), "utf8");
  }

  it.each(["ci.yml", "db.yml", "deploy-check.yml"])(
    "%s runs on a push to each branch that deploys",
    (name) => {
      expect(workflow(name)).toContain("branches: [main, staging]");
    },
  );

  // Docs can hold a leaked secret or a real ID, and the format and URL checks read them.
  it("always runs the checks that read docs", () => {
    expect(workflow("ci.yml")).not.toContain("paths-ignore");
    expect(workflow("pr-metadata.yml")).not.toContain("paths-ignore");
  });

  it.each(["db.yml", "deploy-check.yml"])(
    "%s skips only a change to prose",
    (name) => {
      const ignored = [
        ...workflow(name).matchAll(/paths-ignore:\n((?: +- .*\n)+)/g),
      ].map((match) => match[1]);

      expect(ignored).toEqual(
        Array.from({ length: 2 }, () =>
          ["docs/**", "README.md", "SECURITY.md"]
            .map((path) => `      - "${path}"\n`)
            .join(""),
        ),
      );
    },
  );

  it("runs the settings check before anything is installed", () => {
    const text = workflow("deploy-check.yml");

    expect(text).toContain("run: bash scripts/check-deploy-settings.sh");
    expect(text.indexOf("check-deploy-settings.sh")).toBeLessThan(
      text.indexOf("Install the Vercel CLI"),
    );
  });

  // Run from inside the checkout, Node falls back to its node_modules for a package
  // the tracer missed, and a deployed function has no such folder.
  it("loads the built functions from outside the checkout", () => {
    const text = workflow("deploy-check.yml");
    const step = text.slice(
      text.indexOf("Check that the built functions load"),
    );

    expect(step).toContain('copy="${RUNNER_TEMP}/built-functions"');
    expect(step).toContain(
      'cp -RL .vercel/output/functions/api/interactions.func "${copy}/"',
    );
    expect(step).toContain(
      'cp -RL .vercel/output/functions/api/cron/reminders.func "${copy}/"',
    );
    expect(step).toContain('cd "${copy}"');
    expect(step).toContain("import(`${base}/interactions.func/");
    expect(step).toContain("import(`${base}/reminders.func/");
  });
});
