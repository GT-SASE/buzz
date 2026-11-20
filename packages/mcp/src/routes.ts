import { readdirSync } from "node:fs";
import path from "node:path";

import { formatBotRoutes } from "./bot";
import { rel, repoPath } from "./repo";

export type Route = { url: string; tag: string; file: string };

const appDir = repoPath("sites/web/src/app");

export function tagFor(url: string): string {
  if (url === "/api" || url.startsWith("/api/")) return "api";
  if (url === "/portal/admin" || url.startsWith("/portal/admin/"))
    return "portal admin";
  if (url === "/portal" || url.startsWith("/portal/")) return "portal member";
  return "marketing";
}

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name === "page.tsx" || e.name === "route.ts") out.push(full);
  }
}

/** Next app routes: route groups `(x)` and parallel slots `@x` leave the URL. */
export function listRoutes(): Route[] {
  const files: string[] = [];
  walk(appDir, files);
  return files
    .map((file) => {
      const segs = path
        .relative(appDir, path.dirname(file))
        .split(path.sep)
        .filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
      const url = `/${segs.join("/")}`;
      return { url, tag: tagFor(url), file: rel(file) };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

export async function formatRoutes(): Promise<string> {
  const next = listRoutes()
    .map((r) => `${r.url}  [${r.tag}]  ${r.file}`)
    .join("\n");
  return `${next}\n\n${await formatBotRoutes()}`;
}
