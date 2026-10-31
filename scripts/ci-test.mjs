import { execSync } from "node:child_process";

/**
 * Vercel CI test task. `@buzz/db#postgres` starts a throwaway Postgres next to
 * this one (turbo.json `with`); wait for it, apply the committed SQL, then run
 * the full suite against it so the integration tests never skip.
 */
const url = "postgres://postgres:postgres@localhost:15433/postgres";

function run(command, env = {}) {
  execSync(command, { stdio: "inherit", env: { ...process.env, ...env } });
}

function ready() {
  try {
    execSync(
      "docker exec buzz-ci-postgres pg_isready -h 127.0.0.1 -U postgres",
      {
        stdio: "ignore",
      },
    );
    return true;
  } catch {
    return false;
  }
}

// The image may still be downloading, so allow up to two minutes.
let waited = 0;
while (!ready()) {
  if (++waited > 120) {
    console.error("Postgres didn't start within 120 seconds.");
    process.exit(1);
  }
  await new Promise((done) => setTimeout(done, 1000));
}

try {
  run("pnpm db:migrate", { DATABASE_URL: url });
  run("pnpm test", { TEST_DATABASE_URL: url });
} finally {
  // The container is turbo's persistent task. Stopping it ends that task, so
  // turbo can exit, and nothing is left running if the tests failed.
  execSync("docker stop buzz-ci-postgres", { stdio: "ignore" });
}
