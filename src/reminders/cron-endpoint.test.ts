// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as endpoint from "../../api/cron/reminders.ts";
import { vercelConfig } from "../../test/support/json.ts";
import { testDatabaseUrl } from "../../test/support/sql-client.ts";
import { STALE_CLAIM_MS } from "./plan.ts";
import {
  DATABASE_CALL_MS,
  DISCORD_OPERATION_MS,
  LOCK_STALE_SECONDS,
  RUN_HARD_STOP_MS,
  RUN_WORK_MS,
} from "./run.ts";
import { fakeId } from "../../test/support/ids.ts";

const SECRET = "c".repeat(40);
const URL_BASE = "https://bot.example.test/api/cron/reminders";
const ROOT = join(import.meta.dirname, "..", "..");

function get(
  headers: Record<string, string> = {},
  query = "",
): Promise<Response> {
  return endpoint.GET(new Request(`${URL_BASE}${query}`, { headers }));
}

const fetchMock = vi.fn<typeof fetch>();

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("unauthorized");
  expect(fetchMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", testDatabaseUrl());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  vi.stubEnv("DISCORD_APP_ID", fakeId(0));
  vi.stubEnv("ALLOWED_GUILD_IDS", fakeId(1));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("refusals", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "c".repeat(31)],
  ])(
    "refuses before any database call when the secret is %s",
    async (_label, secret) => {
      vi.stubEnv("CRON_SECRET", secret);
      for (const headers of [
        {},
        { authorization: "Bearer undefined" },
        { authorization: `Bearer ${String(secret)}` },
      ]) {
        await expectRefused(await get(headers));
      }
    },
  );

  it("refuses a wrong secret", async () => {
    await expectRefused(
      await get({ authorization: `Bearer ${"d".repeat(40)}` }),
    );
  });

  it("refuses Bearer undefined with a real secret set", async () => {
    await expectRefused(await get({ authorization: "Bearer undefined" }));
  });

  it("refuses spoofed cron headers and a cron user agent", async () => {
    await expectRefused(
      await get({
        "x-vercel-cron": "1",
        "x-vercel-cron-schedule": "0 15 * * *",
        "x-vercel-id": "abc",
        "user-agent": "vercel-cron/1.0",
      }),
    );
  });

  it.each(["secret", "token", "authorization", "CRON_SECRET"])(
    "refuses the secret in the query string as ?%s=",
    async (name) => {
      await expectRefused(await get({}, `?${name}=${SECRET}`));
      // A handler falling back to the query would compare it with the whole header value.
      await expectRefused(await get({}, `?${name}=Bearer%20${SECRET}`));
    },
  );

  it("gives every refusal the same body", async () => {
    const bodies = new Set<string>();
    for (const headers of [
      {},
      { authorization: "Bearer undefined" },
      { authorization: `Bearer ${"d".repeat(40)}` },
    ]) {
      bodies.add(await (await get(headers)).text());
    }
    vi.stubEnv("CRON_SECRET", undefined);
    bodies.add(await (await get()).text());
    expect([...bodies]).toEqual(["unauthorized"]);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["short", "c".repeat(31)],
  ])("logs one fixed line when the secret is %s", async (_label, secret) => {
    vi.stubEnv("CRON_SECRET", secret);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await get({ authorization: `Bearer ${SECRET}` });
    expect(error.mock.calls).toEqual([["Cron secret is unset or too short"]]);
  });

  it("logs nothing for a wrong header", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await get({ authorization: `Bearer ${"d".repeat(40)}` });
    await get();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("offers GET and nothing else", () => {
    expect(Object.keys(endpoint)).toEqual(["GET"]);
  });
});

describe("deployment settings", () => {
  const vercel = vercelConfig(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const maxSeconds =
    vercel.functions["api/cron/reminders.ts"]?.maxDuration ?? 0;

  it("schedules a morning run and a recovery run of this endpoint", () => {
    expect(vercel.crons).toEqual([
      { path: "/api/cron/reminders", schedule: "0 15 * * *" },
      { path: "/api/cron/reminders", schedule: "0 17 * * *" },
    ]);
  });

  it("leaves more than the stale claim age between the two crons", () => {
    // A claim left by a failed morning run must be stale by the recovery run. Hobby
    // fires anywhere in the hour, so only one started by 16:00 is sure to be.
    expect(17 - 15).toBeGreaterThan(STALE_CLAIM_MS / 3_600_000);
  });

  it("stops new work with time left for one send and its marks", () => {
    expect(
      RUN_WORK_MS + DATABASE_CALL_MS + DISCORD_OPERATION_MS,
    ).toBeLessThanOrEqual(RUN_HARD_STOP_MS);
  });

  it("records the run inside the limit, after the last marks that may start", () => {
    expect(RUN_HARD_STOP_MS + 2 * DATABASE_CALL_MS).toBeLessThanOrEqual(
      maxSeconds * 1000,
    );
  });

  it("treats a run as dead only after the function must have ended", () => {
    expect(LOCK_STALE_SECONDS).toBeGreaterThan(maxSeconds);
  });
});
