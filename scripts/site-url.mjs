import { readFileSync } from "node:fs";

/**
 * The live site's origin, read from sites/web/src/data/site.ts so there is one
 * place to change it. `override` (an env var at the call site) wins.
 */
export function siteUrl(override) {
  if (override) return override.replace(/\/$/, "");
  const source = readFileSync(
    new URL("../sites/web/src/data/site.ts", import.meta.url),
    "utf8",
  );
  const match = /\burl:\s*"([^"]+)"/.exec(source);
  if (!match) throw new Error("No url in sites/web/src/data/site.ts");
  return match[1].replace(/\/$/, "");
}
