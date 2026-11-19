import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { listDir, readRepoFile, repoPath } from "./repo";

const run = promisify(execFile);

export function migrations(): string {
  const files = listDir("packages/db/drizzle").filter((f) =>
    f.endsWith(".sql"),
  );
  const latest = files.at(-1);
  const n = Number(latest?.slice(0, 4));
  return [
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
  ].join("\n");
}

export async function version(): Promise<string> {
  const pkg = JSON.parse(readRepoFile("sites/web/package.json")) as {
    version: string;
  };
  const lines = [`sites/web/package.json version: ${pkg.version}`];
  try {
    const { appBuild } = (await import(
      pathToFileURL(repoPath("sites/web/build-version.ts")).href
    )) as { appBuild: () => { version: string; commit: string } };
    const b = appBuild();
    lines.push(`computed build: ${b.version} (commit ${b.commit})`);
  } catch (e) {
    lines.push(`computed build unavailable: ${(e as Error).message}`);
  }
  lines.push(
    "Rule: MAJOR.MINOR from package.json by hand; PATCH = first-parent commits since the version line last changed, rolls into MINOR at 100.",
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

/** Never touches /api/health or any route that reads the database. */
export async function deployStatus(): Promise<string> {
  const lines: string[] = [];
  try {
    const sha = await gh("api", `repos/${REPO}/commits/main`, "--jq", ".sha");
    const msg = await gh(
      "api",
      `repos/${REPO}/commits/${sha}`,
      "--jq",
      '.commit.message | split("\\n")[0]',
    );
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
    const shallow = (
      await run("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: repoPath("sites/web"),
        timeout: 5_000,
      })
    ).stdout.trim();
    if (shallow === "true") return fallback;
    const { appBuild } = (await import(
      pathToFileURL(repoPath("sites/web/build-version.ts")).href
    )) as { appBuild: () => { version: string } };
    return appBuild().version;
  } catch {
    return fallback;
  }
}
