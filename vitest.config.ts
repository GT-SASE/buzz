import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Tests read TEST_DATABASE_URL only. DATABASE_URL is cleared so nothing can
 * fall back to the deployment's database; unset means the DB suites skip.
 */
const envFile = resolve(import.meta.dirname, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  process.env.DATABASE_URL = testDatabaseUrl;
} else {
  delete process.env.DATABASE_URL;
}

const workspaceAlias = [
  { find: "~", replacement: resolve(import.meta.dirname, "sites/web/src") },
  {
    find: /^@buzz\/db$/,
    replacement: resolve(import.meta.dirname, "packages/db/src/index.ts"),
  },
  {
    find: /^@buzz\/api$/,
    replacement: resolve(import.meta.dirname, "packages/api/src/index.ts"),
  },
  {
    find: /^@buzz\/auth$/,
    replacement: resolve(import.meta.dirname, "packages/auth/src/index.ts"),
  },
] as const;

/**
 * Two projects so Node keeps `process.env.TZ` semantics (forks) while the
 * portal React suite can spin up jsdom without poisoning the timezone fixture.
 */
export default defineConfig({
  test: {
    // Integration tests share one database, so they must not race each other
    // for the same seeded rows.
    fileParallelism: false,
    projects: [
      {
        resolve: { alias: [...workspaceAlias] },
        test: {
          name: "node",
          environment: "node",
          include: ["tests/**/*.test.ts"],
          fileParallelism: false,
        },
      },
      {
        resolve: {
          alias: [
            ...workspaceAlias,
            {
              find: /^next\/navigation$/,
              replacement: resolve(
                import.meta.dirname,
                "tests/mocks/next-navigation.ts",
              ),
            },
          ],
        },
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["tests/**/*.test.tsx"],
          fileParallelism: false,
          // Threads, not forks: only the node project needs fork semantics for
          // process.env.TZ, and forking this one times out starting its worker.
          pool: "threads",
        },
      },
    ],
  },
});
