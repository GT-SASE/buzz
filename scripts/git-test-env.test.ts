import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolatedGitEnv } from "../test/support/git-env.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHELL_HELPER = join(REPO_ROOT, "scripts/lib/git-test-env.sh");
const VITEST = join(REPO_ROOT, "node_modules/vitest/vitest.mjs");

const REDIRECTING_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_PREFIX",
];

describe("Git isolation in tests", () => {
  let root: string;
  let shared: string;
  let scratch: string;

  function git(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    return spawnSync("git", args, { cwd, env, encoding: "utf8" });
  }

  // Everything an escaped Git command would change.
  function sharedState() {
    return {
      config: readFileSync(join(shared, "config"), "utf8"),
      index: existsSync(join(shared, "index")),
      objects: readdirSync(join(shared, "objects")).sort(),
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git-test-env-"));
    shared = join(root, "shared.git");
    scratch = join(root, "scratch");
    mkdirSync(scratch);
    const env = isolatedGitEnv();
    expect(git(["init", "-q", "--bare", shared], root, env).status).toBe(0);
    // A real repository's shared config says false, which is what `git init`
    // overwrites. Left at the true of a new bare repository, the damage would
    // not show.
    const setBare = ["config", "core.bare", "false"];
    expect(git(setBare, shared, { ...env, GIT_DIR: shared }).status).toBe(0);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("detects the damage an inherited GIT_DIR does", () => {
    const before = sharedState();

    const env = { ...isolatedGitEnv(), GIT_DIR: shared };
    expect(git(["init", "-q"], scratch, env).status).toBe(0);

    expect(before.config).toMatch(/bare = false/);
    expect(sharedState().config).toMatch(/bare = true/);
  });

  it("isolatedGitEnv drops the inherited variables and stays out of the repository", () => {
    for (const name of REDIRECTING_VARIABLES) {
      vi.stubEnv(name, shared);
    }
    const before = sharedState();

    const env = isolatedGitEnv();
    for (const name of REDIRECTING_VARIABLES) {
      expect(env[name], name).toBeUndefined();
    }
    expect(git(["init", "-q"], scratch, env).status).toBe(0);
    expect(git(["config", "test.key", "1"], scratch, env).status).toBe(0);
    expect(git(["add", "-A"], scratch, env).status).toBe(0);

    expect(existsSync(join(scratch, ".git/config"))).toBe(true);
    expect(sharedState()).toEqual(before);
  });

  it("git-test-env.sh drops the inherited variables and stays out of the repository", () => {
    const before = sharedState();
    const inherited = Object.fromEntries(
      REDIRECTING_VARIABLES.map((name) => [name, shared]),
    );

    const result = spawnSync(
      "bash",
      [
        "-euc",
        `source "$1"; git init -q; git config test.key 1; git add -A; env`,
        "bash",
        SHELL_HELPER,
      ],
      {
        cwd: scratch,
        env: { ...isolatedGitEnv(), ...inherited },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    for (const name of REDIRECTING_VARIABLES) {
      expect(result.stdout, name).not.toContain(`${name}=`);
    }
    expect(existsSync(join(scratch, ".git/config"))).toBe(true);
    expect(sharedState()).toEqual(before);
  });

  it("keeps the tests that run Git from touching a repository named by GIT_DIR", () => {
    const before = sharedState();

    const result = spawnSync(
      process.execPath,
      [
        VITEST,
        "run",
        "scripts/discord-boundary-lint.test.ts",
        "scripts/check-commit-messages.test.ts",
      ],
      {
        cwd: REPO_ROOT,
        env: { ...isolatedGitEnv(), GIT_DIR: shared },
        encoding: "utf8",
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(sharedState()).toEqual(before);
  }, 120_000);

  it.each([
    "test-gitleaks-full-history.sh",
    "test-gitleaks-rules.sh",
    "test-pre-push-hook.sh",
  ])("%s loads the shell helper", (script) => {
    expect(readFileSync(join(REPO_ROOT, "scripts", script), "utf8")).toContain(
      'source "${repo_root}/scripts/lib/git-test-env.sh"',
    );
  });
});
