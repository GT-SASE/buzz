import { spawn } from "node:child_process";

import { readEnvFileValue, repoPath, repoRoot } from "./repo";

export const CHECK_TASKS = [
  "lint",
  "typecheck",
  "format",
  "test",
  "typecheck:tsc",
  "bot:test",
  "bot:test:db",
  "bot:test:db:concurrency",
] as const;
export type CheckTask = (typeof CHECK_TASKS)[number];

/** Turbo task ids per check; see `check` in package.json and turbo.json. */
const TURBO_TASKS: Record<CheckTask, string[]> = {
  lint: ["//#lint"],
  typecheck: ["typecheck", "//#typecheck:self"],
  format: ["//#format:check"],
  test: ["//#test"],
  "typecheck:tsc": ["typecheck:tsc", "//#typecheck:tsc:self"],
  // The bot's own turbo tasks.
  "bot:test": ["test"],
  "bot:test:db": ["test:db"],
  "bot:test:db:concurrency": [],
};

/** Tasks that run test code, so they need a guarded scratch database. */
const NEEDS_TEST_DATABASE = new Set<CheckTask>([
  "test",
  "bot:test",
  "bot:test:db",
  "bot:test:db:concurrency",
]);

const BOT_DIR = "sites/discord-bot";
const CONCURRENCY_SCRIPT = ["run", "--cwd", BOT_DIR, "test:db:concurrency"];

/**
 * The commands a task list expands to, without running anything. The bot's
 * concurrency suite has no turbo task, so it is its own `bun run` command.
 */
export function planChecks(tasks: CheckTask[], force = false): string[][] {
  const turbo = [...new Set(tasks.flatMap((t) => TURBO_TASKS[t]))];
  const plan: string[][] = [];
  if (turbo.length > 0) {
    plan.push(["x", "turbo", "run", ...turbo, ...(force ? ["--force"] : [])]);
  }
  if (tasks.includes("bot:test:db:concurrency")) plan.push(CONCURRENCY_SCRIPT);
  return plan;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Refuses to run the test suite against anything but a local scratch database.
 * Pure: the caller passes the repo .env DATABASE_URL (production) in.
 */
export function guardTestDatabase(
  env: Record<string, string | undefined>,
  repoEnvDatabaseUrl: string | undefined,
  key = "TEST_DATABASE_URL",
): GuardResult {
  const url = env[key]?.trim();
  if (!url) {
    return {
      ok: false,
      reason: `${key} is not set in the MCP server's environment. Create a disposable Postgres (pgx) and start the server with ${key} pointing at it.`,
    };
  }
  if (url.toLowerCase().includes("neon.tech")) {
    return { ok: false, reason: `${key} points at neon.tech.` };
  }
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `${key} is not a valid URL.` };
  }
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      reason: `${key} host "${host}" is not localhost, 127.0.0.1 or ::1.`,
    };
  }
  if (url === repoEnvDatabaseUrl?.trim()) {
    return {
      ok: false,
      reason: `${key} equals DATABASE_URL in the repo .env.`,
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
  if (tasks.some((t) => NEEDS_TEST_DATABASE.has(t))) {
    const prod = readEnvFileValue(repoPath(".env"), "DATABASE_URL");
    // The concurrency suite connects through its own URL, so that one is checked too.
    const keys = tasks.includes("bot:test:db:concurrency")
      ? ["TEST_DATABASE_URL", "CONCURRENCY_DATABASE_URL"]
      : ["TEST_DATABASE_URL"];
    for (const key of keys) {
      const guard = guardTestDatabase(env, prod, key);
      if (!guard.ok) return { ok: false, output: `Refused: ${guard.reason}` };
    }
  }
  // Production credentials must never reach a child. Tests get their database
  // from TEST_DATABASE_URL (tests/setup/env.ts copies it over).
  delete env.DATABASE_URL;
  env.SKIP_ENV_VALIDATION = "1";
  env.MSYS_NO_PATHCONV = "1";

  let output = "";
  for (const args of planChecks(tasks, force)) {
    const r = await runBun(args, env);
    output += `${output ? "\n\n" : ""}bun ${args.join(" ")}\n${r.output}`;
    if (!r.ok) return { ok: false, output };
  }
  return { ok: true, output };
}

function runBun(args: string[], env: NodeJS.ProcessEnv): Promise<CheckResult> {
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
      resolve({ ok: code === 0, output: tail });
    });
  });
}
