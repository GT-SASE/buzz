import { defineConfig } from "vitest/config";

// Deliberately no passWithNoTests: finding no tests must fail the run.
export default defineConfig({
  test: {
    include: ["test/db-concurrency/**/*.test.ts"],
    allowOnly: false,
    // Each file bootstraps its own database, but roles belong to the whole cluster, so two
    // files setting up at once fail with "tuple concurrently updated".
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
