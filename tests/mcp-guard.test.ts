import { describe, expect, it } from "bun:test";

import { guardTestDatabase } from "../packages/mcp/src/checks";
import { latestVercelStatuses } from "../packages/mcp/src/project";

const prod = "postgresql://u:p@localhost:5432/prod";

describe("guardTestDatabase", () => {
  it("refuses when TEST_DATABASE_URL is missing", () => {
    expect(guardTestDatabase({}, undefined).ok).toBe(false);
  });

  it("refuses neon.tech", () => {
    const r = guardTestDatabase(
      { TEST_DATABASE_URL: "postgresql://u:p@localhost/x?host=a.neon.tech" },
      undefined,
    );
    expect(r.ok).toBe(false);
  });

  it("refuses a non-local host", () => {
    const r = guardTestDatabase(
      { TEST_DATABASE_URL: "postgresql://u:p@db.example.com:5432/x" },
      undefined,
    );
    expect(r.ok).toBe(false);
  });

  it("refuses the URL from the repo .env", () => {
    const r = guardTestDatabase({ TEST_DATABASE_URL: prod }, prod);
    expect(r).toEqual({
      ok: false,
      reason: "TEST_DATABASE_URL equals DATABASE_URL in the repo .env.",
    });
  });

  it("accepts a local scratch database", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const r = guardTestDatabase(
        { TEST_DATABASE_URL: `postgresql://u:p@${host}:5544/scratch` },
        prod,
      );
      expect(r.ok).toBe(true);
    }
  });
});

describe("latestVercelStatuses", () => {
  it("keeps only the newest status per context", () => {
    const rows = [
      { context: "Vercel", state: "success", description: "done" },
      { context: "ci/other", state: "success", description: "" },
      { context: "Vercel", state: "pending", description: "deploying" },
    ];
    expect(latestVercelStatuses(rows)).toEqual([rows[0]!]);
  });
});
