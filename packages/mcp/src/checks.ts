import { spawn } from "node:child_process";

import { readEnvFileValue, repoPath, repoRoot } from "./repo";

export const CHECK_TASKS = [
  "lint",
  "typecheck",
  "format",
  "test",
  "typecheck:tsc",
] as const;
export type CheckTask = (typeof CHECK_TASKS)[number];

/** Turbo task ids per check; see `check` in package.json and turbo.json. */
const TURBO_TASKS: Record<CheckTask, string[]> = {
  lint: ["//#lint"],
  typecheck: ["typecheck", "//#typecheck:self"],
  format: ["//#format:check"],
  test: ["//#test"],
  "typecheck:tsc": ["typecheck:tsc", "//#typecheck:tsc:self"],
};

export type GuardResult = { ok: true } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refuses to run the test suite against anything but a local scratch database.
 * Pure: the caller passes the repo .env DATABASE_URL (production) in.
 */
export function guardTestDatabase(
  env: Record<string, string | undefined>,
  repoEnvDatabaseUrl: string | undefined,
): GuardResult {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) {
    return {
      ok: false,
      reason:
        "TEST_DATABASE_URL is not set in the MCP server's environment. Create a disposable Postgres (pgx) and start the server with TEST_DATABASE_URL pointing at it.",
    };
  }
  if (url.toLowerCase().includes("neon.tech")) {
    return { ok: false, reason: "TEST_DATABASE_URL points at neon.tech." };
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "TEST_DATABASE_URL is not a valid URL." };
  }
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `TEST_DATABASE_URL host "${host}" is not localhost, 127.0.0.1 or ::1.`,
    };
  }
  if (url === repoEnvDatabaseUrl?.trim()) {
    return {
      ok: false,
      reason: "TEST_DATABASE_URL equals DATABASE_URL in the repo .env.",
    };
  }
  return { ok: true };
}

export type CheckResult = { ok: boolean; output: string };

export async function runChecks(
  tasks: CheckTask[],
  force = false,
): Promise<CheckResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (tasks.includes("test")) {
    const guard = guardTestDatabase(
      env,
      readEnvFileValue(repoPath(".env"), "DATABASE_URL"),
    );
    if (!guard.ok) return { ok: false, output: `Refused: ${guard.reason}` };
  }
  // Production credentials must never reach a child. Tests get their database
  // from TEST_DATABASE_URL (tests/setup/env.ts copies it over).
  delete env.DATABASE_URL;
  env.SKIP_ENV_VALIDATION = "1";
  env.MSYS_NO_PATHCONV = "1";

  const turbo = [...new Set(tasks.flatMap((t) => TURBO_TASKS[t]))];
  const args = ["x", "turbo", "run", ...turbo, ...(force ? ["--force"] : [])];

  return new Promise((resolve) => {
    const child = spawn("bun", args, { cwd: repoRoot, env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `Failed to start: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trimEnd().split(/\r?\n/).slice(-80).join("\n");
      resolve({ ok: code === 0, output: `bun ${args.join(" ")}\n${tail}` });
    });
  });
}
