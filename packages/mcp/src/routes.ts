import { readdirSync } from "node:fs";
import path from "node:path";

import { rel, repoPath } from "./repo";

export type Route = { url: string; tag: string; file: string };

const appDir = repoPath("sites/web/src/app");

function tagFor(url: string): string {
  if (url === "/api" || url.startsWith("/api/")) return "api";
  if (url === "/portal/admin" || url.startsWith("/portal/admin/"))
    return "portal admin";
  if (url === "/portal" || url.startsWith("/portal/")) return "portal member";
  return "marketing";
}

/** Next app routes: route groups `(x)` and parallel slots `@x` leave the URL. */
export function listRoutes(): Route[] {
  return readdirSync(appDir, { recursive: true, encoding: "utf8" })
    .filter((f) => ["page.tsx", "route.ts"].includes(path.basename(f)))
    .map((f) => {
      const segs = path
        .dirname(f)
        .split(path.sep)
        .filter((s) => s !== "." && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
      const url = `/${segs.join("/")}`;
      return { url, tag: tagFor(url), file: rel(path.join(appDir, f)) };
    })
    .sort((a, b) => a.url.localeCompare(b.url));
}

export function formatRoutes(): string {
  return listRoutes()
    .map((r) => `${r.url}  [${r.tag}]  ${r.file}`)
    .join("\n");
}
