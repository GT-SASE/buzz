import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedGitEnv } from "../test/support/git-env.ts";
import { checkCommitMessage, checkHeader } from "./check-commit-messages.ts";

describe("checkHeader", () => {
  it.each([
    "feat: add a command",
    "fix(reminders): send only once",
    "feat(api)!: change the response shape",
    "build(deps-dev): bump the development group with 3 updates",
    "ci(deps): bump actions/checkout from 7.0.0 to 7.0.1",
    "docs: x",
  ])("accepts %j", (header) => {
    expect(checkHeader(header)).toEqual([]);
  });

  it.each([
    "add a command",
    "Initial commit",
    "Feat: capitalised type",
    "feature: unknown type",
    "feat:missing space",
    "feat:  two spaces",
    "feat: ",
    "feat: trailing space ",
    "feat(): empty scope",
    "feat(Scope): capitalised scope",
    "feat(a b): space in scope",
    "fixup! feat: add a command",
    "squash! feat: add a command",
    'Revert "feat: add a command"',
    "Merge branch 'main' into feature",
    "",
  ])("rejects %j", (header) => {
    expect(checkHeader(header)).toHaveLength(1);
  });

  it("enforces the length limit", () => {
    const prefix = "feat: ";
    expect(checkHeader(prefix + "x".repeat(100 - prefix.length))).toEqual([]);
    expect(checkHeader(prefix + "x".repeat(101 - prefix.length))).toHaveLength(
      1,
    );
  });
});

describe("checkCommitMessage", () => {
  it("accepts a header with a body and other trailers", () => {
    const message =
      "fix: handle an empty list\n\nThe reason.\n\nSigned-off-by: Example <user@example.com>\n";
    expect(checkCommitMessage(message)).toEqual([]);
  });

  it("does not mistake prose about co-authors for a trailer", () => {
    const message = "docs: explain why Co-authored-by: lines are refused\n";
    expect(checkCommitMessage(message)).toEqual([]);
  });

  it.each([
    "Co-authored-by: Example <user@example.com>",
    "co-authored-by: Example <user@example.com>",
    "CO-AUTHORED-BY: Example <user@example.com>",
    "  Co-Authored-By : Example <user@example.com>",
  ])("rejects the trailer %j", (trailer) => {
    const message = `feat: add a command\n\nBody.\n\n${trailer}\n`;
    expect(checkCommitMessage(message)).toEqual([
      "Co-authored-by trailers are not allowed",
    ]);
  });

  it("rejects a trailer in the middle of the body", () => {
    const message = `feat: add a command\n\nCo-authored-by: Example <user@example.com>\n\nMore text.\n`;
    expect(checkCommitMessage(message)).toHaveLength(1);
  });

  it("requires a blank line after the header", () => {
    expect(checkCommitMessage("feat: add a command\nBody.\n")).toEqual([
      "the header must be followed by a blank line",
    ]);
  });
});

describe("command line", () => {
  const script = fileURLToPath(
    new URL("check-commit-messages.ts", import.meta.url),
  );
  let repo: string;

  const env = {
    ...isolatedGitEnv(),
    GIT_AUTHOR_NAME: "Example",
    GIT_AUTHOR_EMAIL: "user@example.com",
    GIT_COMMITTER_NAME: "Example",
    GIT_COMMITTER_EMAIL: "user@example.com",
  };

  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };

  const commit = (message: string): void => {
    git("commit", "--allow-empty", "-m", message);
  };

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: repo,
      env,
      encoding: "utf8",
    });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "check-commit-messages-"));
    git("init", "--quiet", "--initial-branch=main");
    commit("Initial commit");
    git("branch", "base");
    commit("feat: add a command");
    git("branch", "good");
    commit("bad message");
    commit("fix: correct it\n\nCo-authored-by: Example <user@example.com>");
    git("branch", "bad");

    git("switch", "--quiet", "--create", "merged", "good");
    git("branch", "side");
    commit("fix: on the main line");
    git("switch", "--quiet", "side");
    commit("fix: on the side");
    git("switch", "--quiet", "merged");
    git("merge", "--quiet", "--no-ff", "-m", "feat: a valid title", "side");
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("passes a range of good commits and ignores the base", () => {
    const result = run("--range", "base..good");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^ok {4}commit [0-9a-f]{12}$/m);
  });

  it("fails on each bad commit in a range", () => {
    const result = run("--range", "good..bad");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"bad message" does not match');
    expect(result.stderr).toContain("Co-authored-by trailers are not allowed");
  });

  it("passes a merge commit with a valid message", () => {
    const result = run("--range", "good..merged");
    expect(result.status, result.stderr).toBe(0);
  });

  it("still checks a merge commit's message", () => {
    git("switch", "--quiet", "--create", "badly-merged", "good");
    git("merge", "--quiet", "--no-ff", "-m", "Merge side", "side");
    const result = run("--range", "good..badly-merged");
    expect(result.status).toBe(1);
    expect(result.stderr.match(/^FAIL/gm)).toHaveLength(1);
  });

  it("fails on an empty range", () => {
    const result = run("--range", "bad..bad");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no commits found");
  });

  it("fails on a range Git cannot resolve", () => {
    expect(run("--range", "missing..bad").status).toBe(1);
  });

  it("treats a range that looks like an option as a revision", () => {
    expect(run("--range=--all").status).toBe(1);
  });

  it("checks a title", () => {
    expect(run("--title=feat: add a command").status).toBe(0);
    expect(run("--title=Add a command").status).toBe(1);
    expect(run("--title=--help").status).toBe(1);
  });

  it("fails when given nothing to check", () => {
    expect(run().status).toBe(1);
  });
});
