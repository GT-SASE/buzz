// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as endpoint from "../../api/cron/reminders.ts";
import {
  CRONS,
  FUNCTIONS,
  MAX_DURATION_SECONDS,
} from "../../scripts/deployment.ts";
import { fakeId } from "../../test/support/ids.ts";
import { testDatabaseUrl } from "../../test/support/sql-client.ts";
import { asFetch, stubEnv } from "../../test/support/stubs.ts";
import {
  FUNCTION_MAX_MS,
  SLOT_START_HOUR_UTC,
  STALE_CLAIM_MS,
} from "./plan.ts";

const SECRET = "c".repeat(40);
const URL_BASE = "https://bot.example.test/api/cron/reminders";

function get(
  headers: Record<string, string> = {},
  query = "",
): Promise<Response> {
  return endpoint.GET(new Request(`${URL_BASE}${query}`, { headers }));
}

const fetchMock = mock(() => Promise.resolve(new Response(null)));

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("unauthorized");
  expect(fetchMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  fetchMock.mockClear();
  spyOn(globalThis, "fetch").mockImplementation(asFetch(fetchMock));
  stubEnv("DATABASE_URL", testDatabaseUrl());
  stubEnv("CRON_SECRET", SECRET);
  stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  stubEnv("DISCORD_APP_ID", fakeId(0));
  stubEnv("ALLOWED_GUILD_IDS", fakeId(1));
});

describe("refusals", () => {
  it.each([
    ["unset", undefined],
    ["short", "c".repeat(31)],
  ])(
    "refuses before any database call when the secret is %s, and logs one fixed line",
    async (_label, secret) => {
      stubEnv("CRON_SECRET", secret);
      const error = spyOn(console, "error").mockImplementation(() => undefined);

      await expectRefused(await get({ authorization: "Bearer undefined" }));
      await expectRefused(
        await get({ authorization: `Bearer ${String(secret)}` }),
      );
      expect(error.mock.calls).toEqual([
        ["Cron secret is unset or too short"],
        ["Cron secret is unset or too short"],
      ]);
    },
  );

  it("refuses a wrong secret and logs nothing", async () => {
    const error = spyOn(console, "error").mockImplementation(() => undefined);

    await expectRefused(
      await get({ authorization: `Bearer ${"d".repeat(40)}` }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("refuses spoofed cron headers and the secret in the query string", async () => {
    await expectRefused(
      await get({ "x-vercel-cron": "1", "user-agent": "vercel-cron/1.0" }),
    );
    await expectRefused(await get({}, `?secret=${SECRET}`));
    await expectRefused(await get({}, `?authorization=Bearer%20${SECRET}`));
  });

  it("offers GET and nothing else", () => {
    expect(Object.keys(endpoint)).toEqual(["GET"]);
  });
});

describe("deployment settings", () => {
  const RECOVERY_HOUR_UTC = SLOT_START_HOUR_UTC + 2;
  const HOUR_MS = 3_600_000;

  it("schedules a morning run and a recovery run of this endpoint", () => {
    expect(CRONS).toEqual([
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

  it("gives the functions the time limit the code is built for", () => {
    expect(FUNCTIONS.map(({ route }) => route).sort()).toEqual([
      "api/cron/reminders",
      "api/interactions",
    ]);
    expect(MAX_DURATION_SECONDS * 1000).toBe(FUNCTION_MAX_MS);
  });

  it("leaves time for a morning run's claims to go stale before the recovery run", () => {
    // Hobby fires anywhere in the hour, so the morning run may start at 15:59 and the
    // recovery run at 17:00.
    expect(
      (RECOVERY_HOUR_UTC - SLOT_START_HOUR_UTC - 1) * HOUR_MS,
    ).toBeGreaterThanOrEqual(FUNCTION_MAX_MS + STALE_CLAIM_MS);
  });
});
