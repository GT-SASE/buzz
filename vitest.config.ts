import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The integration suite talks to the real database, so it needs the same
 * credentials the app uses. Loaded here rather than in each test file so a
 * single missing `.env` produces one clear skip rather than a dozen failures.
 */
const envFile = resolve(import.meta.dirname, "sites/web/.env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

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
        },
      },
    ],
  },
});
