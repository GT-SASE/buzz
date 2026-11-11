import { defineConfig } from "vitest/config";

// Date maths must never depend on the machine's zone. New York has DST, so code
// that slips into local time fails here even on a machine or CI runner set to UTC.
process.env.TZ = "America/New_York";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/*.test.ts"],
    // Many tests spawn bash or git. They take well under a second alone, but the default
    // 5 seconds runs out when other suites are using every core at once.
    testTimeout: 30_000,
  },
});
