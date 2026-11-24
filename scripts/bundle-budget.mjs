import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

/**
 * Per-route bundle budget. Run after `bun run vercel-build`.
 *
 * Each prerendered page lists the script and stylesheet files it loads; the
 * size of a route is the gzipped total of those files (the same files every
 * time for one source tree, so the number is deterministic). A route fails
 * when it passes its budget. Budgets are the size at 3.0.0 plus about 10%:
 * real growth fails CI, build-to-build noise does not. When a route grows on
 * purpose, raise its line in the same PR and say why.
 *
 * Usage: bun scripts/bundle-budget.mjs [--print]
 */
const next = new URL("../sites/web/.next/", import.meta.url);

// route -> prerendered file under .next/server/app, budget in gzipped bytes.
const BUDGETS = {
  "/": ["index.html", 245760],
  "/about": ["about.html", 245760],
  "/board": ["board.html", 245760],
  "/contact": ["contact.html", 245760],
  "/discord": ["discord.html", 245760],
  "/events": ["events.html", 247808],
  "/faq": ["faq.html", 245760],
  "/join": ["join.html", 245760],
  "/programs": ["programs.html", 245760],
  "/sponsors": ["sponsors.html", 245760],
  "/status": ["status.html", 260096],
  "/website-team": ["website-team.html", 245760],
  "/portal/signin": ["portal/signin.html", 246784],
};

const print = process.argv.includes("--print");
let failed = false;

for (const [route, [file, budget]] of Object.entries(BUDGETS)) {
  const html = readFileSync(new URL(`server/app/${file}`, next), "utf8");
  const urls = new Set(
    [...html.matchAll(/\/_next\/static\/[^"'\s)<>]+?\.(?:js|css)/g)].map(
      (m) => m[0],
    ),
  );
  let gz = 0;
  for (const u of urls) {
    gz += gzipSync(
      readFileSync(new URL(u.replace("/_next/", ""), next)),
    ).length;
  }
  const kb = (n) => `${(n / 1024).toFixed(1)} kB`;
  if (print) {
    console.log(`${route}\t${gz}\t(${urls.size} files, ${kb(gz)})`);
  } else if (gz > budget) {
    failed = true;
    console.error(
      `FAIL ${route}: ${kb(gz)} > budget ${kb(budget)} (${urls.size} files)`,
    );
  } else {
    console.log(`ok   ${route}: ${kb(gz)} <= ${kb(budget)}`);
  }
}
if (failed) process.exit(1);
