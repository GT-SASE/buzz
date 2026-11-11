import { defineConfig } from "vitest/config";

// Needs POSTGREST_URL, POSTGREST_DATABASE_URL and PGRST_JWT_SECRET. Without them the
// access layer tests would use the local stand-in, so this config requires the URL.
if (!process.env.POSTGREST_URL) {
  throw new Error("POSTGREST_URL must be set for test:postgrest");
}

export default defineConfig({
  test: {
    include: ["test/db/access-layer.test.ts"],
    allowOnly: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
