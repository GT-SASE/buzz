// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as endpoint from "../../api/cron/reminders.ts";
import { vercelConfig } from "../../test/support/json.ts";
import { testDatabaseUrl } from "../../test/support/sql-client.ts";
import {
  FUNCTION_MAX_MS,
  SLOT_START_HOUR_UTC,
  STALE_CLAIM_MS,
} from "./plan.ts";
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
  const RECOVERY_HOUR_UTC = SLOT_START_HOUR_UTC + 2;
  const HOUR_MS = 3_600_000;

  it("schedules a morning run and a recovery run of this endpoint", () => {
    expect(vercel.crons).toEqual([
      {
        path: "/api/cron/reminders",
        schedule: `0 ${String(SLOT_START_HOUR_UTC)} * * *`,
      },
      {
        path: "/api/cron/reminders",
        schedule: `0 ${String(RECOVERY_HOUR_UTC)} * * *`,
      },
    ]);
  });

  it.each(["api/cron/reminders.ts", "api/interactions.ts"])(
    "gives %s the time limit the code is built for",
    (path) => {
      expect((vercel.functions[path]?.maxDuration ?? 0) * 1000).toBe(
        FUNCTION_MAX_MS,
      );
    },
  );

  it("leaves time for a morning run's claims to go stale before the recovery run", () => {
    // Hobby fires anywhere in the hour, so the morning run may start at 15:59 and the
    // recovery run at 17:00.
    expect(
      (RECOVERY_HOUR_UTC - SLOT_START_HOUR_UTC - 1) * HOUR_MS,
    ).toBeGreaterThanOrEqual(FUNCTION_MAX_MS + STALE_CLAIM_MS);
  });
});
