import { execSync } from "node:child_process";

/**
 * Vercel Root Directory is sites/web, so this runs from the repo root via
 * `cd ../.. && pnpm vercel-build`. Apply committed SQL when a database is
 * configured; skip when a preview has none so the public site still builds.
 */
function run(command) {
  execSync(command, { stdio: "inherit" });
}

if (process.env.DATABASE_URL) {
  run("pnpm db:migrate");
} else {
  console.log("DATABASE_URL unset; skipping migrate");
}

run("pnpm --filter @buzz/web build");
