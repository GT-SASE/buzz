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

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors sites/web/tsconfig.json so tests can import the web app's
      // modules by the same specifier the app uses.
      "~": resolve(import.meta.dirname, "sites/web/src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests share one database, so they must not race each other
    // for the same seeded rows.
    fileParallelism: false,
  },
});
