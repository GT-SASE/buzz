import { defineConfig } from "vitest/config";

// Date maths must never depend on the machine's zone. New York has DST, so code
// that slips into local time fails here even on a machine or CI runner set to UTC.
process.env.TZ = "America/New_York";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "test/*.test.ts"],
  },
});
