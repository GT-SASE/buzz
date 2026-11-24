import { describe, expect, it } from "bun:test";

import {
  guardTestDatabase,
  planChecks,
  runChecks,
} from "../packages/mcp/src/checks";
import {
  ciStatus,
  formatCiRun,
  latestVercelStatuses,
  migrations,
  version,
} from "../packages/mcp/src/project";

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

describe("bot check tasks", () => {
  it("maps bot tasks to the bot's turbo tasks", () => {
    expect(planChecks(["bot:test", "bot:test:db"], true)).toEqual([
      ["x", "turbo", "run", "test", "test:db", "--force"],
    ]);
  });

  it("runs the concurrency suite as its own command, never via turbo", () => {
    expect(planChecks(["bot:test:db:concurrency"])).toEqual([
      ["run", "--cwd", "sites/discord-bot", "test:db:concurrency"],
    ]);
  });

  it("refuses bot tasks without a scratch TEST_DATABASE_URL", async () => {
    const saved = process.env.TEST_DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    try {
      for (const t of [
        "bot:test",
        "bot:test:db",
        "bot:test:db:concurrency",
      ] as const) {
        const r = await runChecks([t]);
        expect(r.ok).toBe(false);
        expect(r.output).toStartWith("Refused: TEST_DATABASE_URL is not set");
      }
    } finally {
      if (saved !== undefined) process.env.TEST_DATABASE_URL = saved;
    }
  });

  it("guards CONCURRENCY_DATABASE_URL like TEST_DATABASE_URL", async () => {
    const saved = { ...process.env };
    process.env.TEST_DATABASE_URL = "postgresql://u:p@localhost:5544/x";
    process.env.CONCURRENCY_DATABASE_URL = "postgresql://u:p@x.neon.tech/x";
    try {
      const r = await runChecks(["bot:test:db:concurrency"]);
      expect(r).toEqual({
        ok: false,
        output: "Refused: CONCURRENCY_DATABASE_URL points at neon.tech.",
      });
    } finally {
      process.env = saved;
    }
  });
});

describe("ciStatus", () => {
  const run = {
    conclusion: "failure",
    status: "completed",
    headSha: "a".repeat(40),
    url: "https://github.com/GT-SASE/buzz/actions/runs/1",
  };

  it("reports a red run as not green", () => {
    expect(formatCiRun([run])).toContain("failure aaaaaaa");
    expect(formatCiRun([run])).toContain("NOT GREEN");
    expect(formatCiRun([{ ...run, conclusion: "success" }])).not.toContain(
      "NOT GREEN",
    );
  });

  it("flags a run for an older commit than main", () => {
    expect(formatCiRun([run], "b".repeat(40))).toContain("not main's bbbbbbb");
  });

  it("uses status while a run is in progress and handles none", () => {
    expect(
      formatCiRun([{ ...run, conclusion: null, status: "in_progress" }]),
    ).toContain("in_progress");
    expect(formatCiRun([])).toContain("no runs found");
  });

  it("degrades when gh is missing", async () => {
    const out = await ciStatus(() =>
      Promise.reject(new Error("spawn gh ENOENT\nmore")),
    );
    expect(out).toBe(
      "github CI (main) unavailable (gh missing or not authed): spawn gh ENOENT",
    );
  });

  it("parses gh's JSON", async () => {
    const out = await ciStatus(() => Promise.resolve(JSON.stringify([run])));
    expect(out).toContain("failure");
  });
});

describe("workspace versions and migrations", () => {
  it("lists the bot workspace in buzz_version and both migration sets", async () => {
    const v = await version();
    expect(v).toContain("@buzz/discord-bot");
    const m = migrations();
    expect(m).toContain("== bot database (Drizzle");
    expect(m).toContain("0000_baseline.sql");
    expect(m).toContain("manual owner step");
    expect(m).toContain("packages/db/drizzle/0011_page.sql");
  });
});
