import { execSync } from "node:child_process";

/**
 * Vercel Root Directory is sites/web, so this runs from the repo root via
 * `cd ../.. && pnpm vercel-build`. Apply committed SQL when a database is
 * configured; skip when a preview has none so the public site still builds.
 */
function run(command) {
  execSync(command, { stdio: "inherit" });
}

// Preview builds share the production DATABASE_URL, so migrating there would
// apply an unmerged branch's SQL to the live database. Only production (and
// local CI, where VERCEL_ENV is unset) migrates.
if (process.env.VERCEL_ENV === "preview") {
  console.log("Preview build; skipping migrate");
} else if (process.env.DATABASE_URL) {
  run("pnpm db:migrate");
} else {
  console.log("DATABASE_URL unset; skipping migrate");
}

run("pnpm --filter @buzz/web build");
