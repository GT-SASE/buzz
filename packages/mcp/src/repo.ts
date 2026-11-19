import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** Repo root, three levels above packages/mcp/src. */
export const repoRoot = path.resolve(import.meta.dirname, "../../..");

export const repoPath = (...parts: string[]) => path.join(repoRoot, ...parts);

export const readRepoFile = (...parts: string[]) =>
  readFileSync(repoPath(...parts), "utf8");

export const rel = (file: string) =>
  path.relative(repoRoot, file).split(path.sep).join("/");

export function listDir(...parts: string[]): string[] {
  const dir = repoPath(...parts);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/**
 * Reads one key out of a dotenv file without loading it into process.env, so
 * the repo's production DATABASE_URL never reaches this process's children.
 */
export function readEnvFileValue(
  file: string,
  key: string,
): string | undefined {
  if (!existsSync(file)) return undefined;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match?.[1] !== key) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    return value;
  }
  return undefined;
}
