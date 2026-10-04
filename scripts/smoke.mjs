import { readFileSync } from "node:fs";

/**
 * Loads the pages people actually hit on the live site and exits non-zero if
 * any is down. The site URL comes from sites/web/src/data/site.ts so there is
 * one place to change it; SMOKE_URL overrides it.
 */
function siteUrl() {
  if (process.env.SMOKE_URL) return process.env.SMOKE_URL;
  const source = readFileSync(
    new URL("../sites/web/src/data/site.ts", import.meta.url),
    "utf8",
  );
  const match = /\burl:\s*"([^"]+)"/.exec(source);
  if (!match) throw new Error("No url in sites/web/src/data/site.ts");
  return match[1];
}

const base = siteUrl().replace(/\/$/, "");

/** [path, text the page must contain] */
const checks = [
  ["/", "Find your people"],
  ["/events", "Events"],
  ["/about", "SASE"],
  ["/join", "Join"],
  ["/contact", "Contact"],
  ["/portal/signin", "Continue with Google"],
  ["/manifest.webmanifest", '"icons"'],
  ["/favicon.ico", null],
  ["/sitemap.xml", "<urlset"],
];

let failed = 0;
for (const [path, expected] of checks) {
  const url = base + path;
  try {
    const response = await fetch(url, { redirect: "follow" });
    const body = expected ? await response.text() : "";
    const ok = response.ok && (expected === null || body.includes(expected));
    console.log(`${ok ? "ok  " : "FAIL"} ${response.status} ${path}`);
    if (!ok) failed++;
  } catch (error) {
    console.log(`FAIL ${path} ${error}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`${failed} of ${checks.length} checks failed on ${base}`);
  process.exit(1);
}
console.log(`All ${checks.length} checks passed on ${base}`);
