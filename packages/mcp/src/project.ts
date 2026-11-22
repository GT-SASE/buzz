import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readdirSync } from "node:fs";

import { BOT_MIGRATIONS_DIR } from "./bot";
import { listDir, readRepoFile, repoPath } from "./repo";

const run = promisify(execFile);

/** Root plus each directory matched by the root workspaces globs ("" is the root). */
function workspaceDirs(): string[] {
  const globs =
    (JSON.parse(readRepoFile("package.json")) as { workspaces?: string[] })
      .workspaces ?? [];
  const dirs = [""];
  for (const glob of globs) {
    const base = glob.replace(/\/\*$/, "");
    for (const e of readdirSync(repoPath(base), { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(`${base}/${e.name}`);
    }
  }
  return dirs;
}

export function migrations(): string {
  const files = listDir("packages/db/drizzle").filter((f) =>
    f.endsWith(".sql"),
  );
  const latest = files.at(-1);
  const n = Number(latest?.slice(0, 4));
  const botFiles = listDir(BOT_MIGRATIONS_DIR).filter((f) =>
    f.endsWith(".sql"),
  );
  return [
    "== buzz database (Drizzle, packages/db/drizzle) ==",
    ...files.map((f) => `packages/db/drizzle/${f}`),
    "",
    `latest: ${latest ?? "none"}; next number: ${String(n + 1).padStart(4, "0")}`,
    "",
    "Process:",
    "1. Edit packages/db/src/schema.ts.",
    "2. bun run db:generate (writes SQL + meta into packages/db/drizzle).",
    "3. Commit the generated SQL and meta with the schema change.",
    "4. bun run db:migrate (against a disposable DB, never the repo .env one).",
    "Production migrates during the Vercel production build via scripts/vercel-build.mjs (previews skip it).",
    "",
    `== bot database (dbmate, ${BOT_MIGRATIONS_DIR}) ==`,
    ...botFiles.map((f) => `${BOT_MIGRATIONS_DIR}/${f}`),
    "",
    `latest: ${botFiles.at(-1) ?? "none"}; next file: a new \`<UTC YYYYMMDDHHMMSS>_<name>.sql\` made by dbmate`,
    "",
    "Process:",
    "1. From sites/discord-bot: bun x --bun --no-install dbmate --migrations-dir db/migrations new <name>. Write SQL under '-- migrate:up'. An applied file never changes; there are no down migrations.",
    "2. Keep bot_app grants and SECURITY DEFINER / empty search_path on any new function.",
    "3. bun run --cwd sites/discord-bot db:migrate against a disposable DB (DATABASE_URL of its owner role, never the repo .env one, never bot_app).",
    "4. bun run --cwd sites/discord-bot test:db (PGlite) pins the schema.",
    "Production is a manual owner step: no build or workflow applies these. Apply migrations first with the owner's direct connection string, then merge the code (sites/discord-bot/docs/RUNBOOK.md, 'Migrations go first, then code').",
  ].join("\n");
}

async function isShallow(): Promise<boolean> {
  return (
    (
      await run("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: repoPath("sites/web"),
        timeout: 5_000,
      })
    ).stdout.trim() === "true"
  );
}

export async function version(): Promise<string> {
  const pkg = JSON.parse(readRepoFile("sites/web/package.json")) as {
    version: string;
  };
  const lines = [`sites/web/package.json version: ${pkg.version}`];
  const mismatched: string[] = [];
  for (const dir of workspaceDirs()) {
    const w = JSON.parse(readRepoFile(dir, "package.json")) as {
      name: string;
      version: string;
    };
    const flag = w.version === pkg.version ? "" : "  MISMATCH";
    if (flag) mismatched.push(w.name);
    lines.push(
      `  ${w.name}  ${w.version}  (${dir || "."}/package.json)${flag}`,
    );
  }
  if (mismatched.length > 0) {
    lines.push(
      `MISMATCH: ${mismatched.join(", ")} differ from the site version; tests/versions.test.ts fails.`,
    );
  }
  try {
    if (await isShallow()) {
      const [major, minor] = pkg.version.split(".");
      lines.push(
        `computed build: skipped on a shallow clone (PATCH needs history); MAJOR.MINOR is ${major}.${minor}`,
      );
    } else {
      const { appBuild } = (await import(
        pathToFileURL(repoPath("sites/web/build-version.ts")).href
      )) as { appBuild: () => { version: string; commit: string } };
      const b = appBuild();
      lines.push(`computed build: ${b.version} (commit ${b.commit})`);
    }
  } catch (e) {
    lines.push(`computed build unavailable: ${(e as Error).message}`);
  }
  lines.push(
    "Rule: one version for the whole repo. MAJOR.MINOR from package.json by hand (every workspace shares X.Y.0); PATCH = first-parent commits since the version line last changed, rolls into MINOR at 100.",
    "",
  );
  const readme = readRepoFile("README.md").split(/\r?\n/);
  const start = readme.findIndex((l) => l.startsWith("| Version |"));
  if (start >= 0) {
    const table: string[] = [];
    for (const l of readme.slice(start)) {
      if (!l.startsWith("|")) break;
      table.push(l);
    }
    lines.push("README.md version table:", ...table);
  }
  return lines.join("\n");
}

async function gh(...args: string[]): Promise<string> {
  const { stdout } = await run("gh", args, { timeout: 30_000 });
  return stdout.trim();
}

const REPO = "GT-SASE/buzz";

export type CommitStatus = {
  context: string;
  state: string;
  description: string;
};

/** GitHub lists statuses newest first and keeps history: keep one per context. */
export function latestVercelStatuses(statuses: CommitStatus[]): CommitStatus[] {
  const seen = new Set<string>();
  return statuses.filter((s) => {
    if (!/vercel/i.test(s.context) || seen.has(s.context)) return false;
    seen.add(s.context);
    return true;
  });
}

export type CiRun = {
  conclusion: string | null;
  status: string;
  headSha: string;
  url: string;
  displayTitle?: string;
};

/** One line for the newest CI run on main; `mainSha` flags a run for an older commit. */
export function formatCiRun(runs: CiRun[], mainSha?: string): string {
  const r = runs[0];
  if (!r) return "github CI (main): no runs found";
  const state = r.conclusion ?? r.status;
  const stale =
    mainSha && r.headSha !== mainSha
      ? ` (run is for ${r.headSha.slice(0, 7)}, not main's ${mainSha.slice(0, 7)})`
      : "";
  const warn = state === "success" ? "" : "  NOT GREEN";
  return `github CI (main): ${state} ${r.headSha.slice(0, 7)}${stale} ${r.url}${warn}`;
}

/** Latest CI conclusion for main. Degrades to a message when gh is missing or fails. */
export async function ciStatus(
  runGh: (...args: string[]) => Promise<string> = gh,
  mainSha?: string,
): Promise<string> {
  try {
    const out = await runGh(
      "run",
      "list",
      "--repo",
      REPO,
      "--workflow",
      "CI",
      "--branch",
      "main",
      "--limit",
      "1",
      "--json",
      "conclusion,status,headSha,url,displayTitle",
    );
    return formatCiRun(JSON.parse(out) as CiRun[], mainSha);
  } catch (e) {
    return `github CI (main) unavailable (gh missing or not authed): ${(e as Error).message.split("\n")[0]}`;
  }
}

/** Never touches /api/health or any route that reads the database. */
export async function deployStatus(): Promise<string> {
  const lines: string[] = [];
  let mainSha: string | undefined;
  try {
    const sha = await gh("api", `repos/${REPO}/commits/main`, "--jq", ".sha");
    const msg = await gh(
      "api",
      `repos/${REPO}/commits/${sha}`,
      "--jq",
      '.commit.message | split("\\n")[0]',
    );
    mainSha = sha;
    lines.push(`main: ${sha.slice(0, 7)} ${msg}`);
    const statuses = JSON.parse(
      await gh("api", `repos/${REPO}/commits/${sha}/statuses`),
    ) as CommitStatus[];
    const vercel = latestVercelStatuses(statuses);
    if (vercel.length === 0) lines.push("vercel status: none reported yet");
    for (const s of vercel) {
      lines.push(`vercel status: ${s.state} (${s.context}) ${s.description}`);
    }
  } catch (e) {
    lines.push(
      `github unavailable (gh missing or not authed): ${(e as Error).message.split("\n")[0]}`,
    );
  }
  lines.push(await ciStatus(gh, mainSha));
  try {
    const res = await fetch("https://buzzsase.vercel.app/", {
      signal: AbortSignal.timeout(15_000),
    });
    const html = await res.text();
    const m = /v(?:<!-- -->)?(\d+\.\d+\.\d+)/.exec(html);
    lines.push(
      `live footer version: ${m ? `v${m[1]}` : "not found"} (HTTP ${res.status})`,
    );
  } catch (e) {
    lines.push(`live site unreachable: ${(e as Error).message}`);
  }
  return lines.join("\n");
}

/**
 * The site's version (footer vX.Y.Z), computed once at startup. A shallow clone
 * would make appBuild fetch over the network, so it gets MAJOR.MINOR.0 from
 * package.json instead.
 */
export async function serverVersion(): Promise<string> {
  const pkg = JSON.parse(readRepoFile("sites/web/package.json")) as {
    version: string;
  };
  const [major, minor] = pkg.version.split(".");
  const fallback = `${major}.${minor}.0`;
  try {
    if (await isShallow()) return fallback;
    const { appBuild } = (await import(
      pathToFileURL(repoPath("sites/web/build-version.ts")).href
    )) as { appBuild: () => { version: string } };
    return appBuild().version;
  } catch {
    return fallback;
  }
}
