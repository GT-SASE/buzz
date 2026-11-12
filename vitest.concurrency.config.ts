import { defineConfig } from "vitest/config";

// Deliberately no passWithNoTests: finding no tests must fail the run.
export default defineConfig({
  test: {
    include: ["test/db-concurrency/**/*.test.ts"],
    allowOnly: false,
    // Makes the cluster's roles and a migrated template once. Each file then copies the
    // template into its own database, so the files can run in parallel.
    globalSetup: ["test/db-concurrency/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
