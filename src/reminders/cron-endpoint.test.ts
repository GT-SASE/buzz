// Lives outside api/ because Vercel turns every file in that directory into a
// function.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as endpoint from "../../api/cron/reminders.ts";
import { STALE_CLAIM_MS } from "./plan.ts";
import {
  DATABASE_CALL_MS,
  DISCORD_OPERATION_MS,
  LOCK_STALE_SECONDS,
  RUN_HARD_STOP_MS,
  RUN_WORK_MS,
} from "./run.ts";

const SECRET = "c".repeat(40);
const URL_BASE = "https://bot.example.test/api/cron/reminders";
const ROOT = join(import.meta.dirname, "..", "..");
const RUN_ID = "00000000-0000-4000-8000-000000000001";

function get(
  headers: Record<string, string> = {},
  query = "",
): Promise<Response> {
  return endpoint.GET(new Request(`${URL_BASE}${query}`, { headers }));
}

const fetchMock = vi.fn<typeof fetch>();

const clients = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("../discord/client.ts", async (original) => {
  const actual = await original<typeof import("../discord/client.ts")>();
  return {
    ...actual,
    createDiscordClient: (
      options: Parameters<typeof actual.createDiscordClient>[0],
    ) => {
      clients.options.push(options);
      return actual.createDiscordClient(options);
    },
  };
});

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe("unauthorized");
  expect(fetchMock).not.toHaveBeenCalled();
}

const GUILD = (10n ** 17n + 1n).toString();
const THREAD = (10n ** 17n + 2n).toString();
const FORUM = (10n ** 17n + 4n).toString();

/** A task due in two days, in an event with a post, as the candidates read returns it. */
function candidateRow() {
  return {
    id: RUN_ID,
    event_id: RUN_ID,
    guild_id: GUILD,
    assignee_id: (10n ** 17n + 3n).toString(),
    description: "Book",
    due_date: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
    status: "open",
    updated_at: "2030-01-01T00:00:00.000000+00:00",
    events: {
      id: RUN_ID,
      name: "Meeting",
      thread_id: THREAD,
      status: "active",
      thread_status: "active",
      thread_refusals: 0,
      managed_channels: { guild_config: { timezone: "UTC" } },
    },
    reminder_log: [],
  };
}

function jobRow(status: string, error: string | null) {
  return {
    id: RUN_ID,
    job_name: "reminders",
    status,
    started_at: "2026-11-04T14:00:00.000Z",
    heartbeat_at: "2026-11-04T14:00:00.000Z",
    finished_at: "2026-11-04T14:00:01.000Z",
    results: {},
    error,
  };
}

beforeEach(() => {
  clients.options = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("SUPABASE_URL", "https://project.example.test");
  vi.stubEnv("SUPABASE_SECRET_KEY", ["sb", "secret", "x".repeat(24)].join("_"));
  vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  vi.stubEnv("DISCORD_APP_ID", (10n ** 17n).toString());
  vi.stubEnv("ALLOWED_GUILD_IDS", (10n ** 17n + 1n).toString());
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
        "x-vercel-cron-schedule": "0 14 * * *",
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

describe("an authorized request", () => {
  const authorized = { authorization: `Bearer ${SECRET}` };

  it("returns a fixed body when another run holds the lock", async () => {
    fetchMock.mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          (input as string).includes("rpc/expire_interaction_claims")
            ? 0
            : null,
        ),
      ),
    );
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const urls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(urls.some((url) => url.includes("rpc/begin_job_run"))).toBe(true);
    expect(urls.some((url) => url.startsWith("https://discord.com"))).toBe(
      false,
    );
  });

  it("returns the same fixed body after a real run", async () => {
    fetchMock.mockImplementation((input) => {
      const url = input as string;
      if (url.includes("rpc/begin_job_run")) {
        return Promise.resolve(Response.json(RUN_ID));
      }
      if (url.includes("rpc/expire_interaction_claims")) {
        return Promise.resolve(Response.json(0));
      }
      if (
        url.includes("/tasks?") ||
        url.includes("/reminder_log?") ||
        url.includes("/managed_channels?")
      ) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([jobRow("succeeded", null)]));
    });
    const response = await get(authorized);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("gives a fixed 500 and no detail when the database fails", async () => {
    const canary = "canary-row-text";
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({ code: "XX000", message: canary }, { status: 500 }),
      ),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await get(authorized);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(canary);
    expect(JSON.stringify(warn.mock.calls)).toContain("unavailable:XX000");
  });

  it("gives a fixed 500 and names only the setting when config is missing", async () => {
    vi.stubEnv("ALLOWED_GUILD_IDS", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await get(authorized);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("ALLOWED_GUILD_IDS");
  });

  it("makes a new Discord client for each invocation", async () => {
    // A 401 on one invocation must not be remembered by the next.
    const row = candidateRow();
    let discordCalls = 0;
    fetchMock.mockImplementation((input) => {
      const url = input as string;
      if (url.startsWith("https://discord.com")) {
        discordCalls += 1;
        return Promise.resolve(new Response("{}", { status: 401 }));
      }
      if (url.includes("rpc/begin_job_run") || url.includes("rpc/claim")) {
        return Promise.resolve(Response.json(RUN_ID));
      }
      if (url.includes("/tasks?")) {
        return Promise.resolve(Response.json([row]));
      }
      if (
        url.includes("/managed_channels?") ||
        url.includes("/reminder_log?")
      ) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(
        Response.json([jobRow("failed", "discord_unauthorized:401")]),
      );
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await get(authorized);
    await get(authorized);
    expect(discordCalls).toBe(2);
  });
});

describe("the Discord client the function builds", () => {
  const authorized = { authorization: `Bearer ${SECRET}` };

  /**
   * The database claims everything here, so the client's own check is all that stands
   * between the reminder and the send. Discord would accept the send.
   */
  function worldWhereForumIs(status: string | undefined) {
    fetchMock.mockImplementation((input, init) => {
      const url = input as string;
      if (url.startsWith("https://discord.com")) {
        return Promise.resolve(
          Response.json(
            init?.method === "POST"
              ? { id: FORUM }
              : { id: THREAD, type: 11, guild_id: GUILD, parent_id: FORUM },
          ),
        );
      }
      if (url.includes("rpc/begin_job_run") || url.includes("rpc/claim")) {
        return Promise.resolve(Response.json(RUN_ID));
      }
      if (url.includes("/tasks?")) {
        return Promise.resolve(Response.json([candidateRow()]));
      }
      if (url.includes("/managed_channels?")) {
        return Promise.resolve(
          Response.json(
            status === undefined
              ? []
              : [{ guild_id: GUILD, channel_id: FORUM, status }],
          ),
        );
      }
      if (url.includes("/reminder_log?")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([jobRow("succeeded", null)]));
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  }

  const discordPosts = () =>
    fetchMock.mock.calls
      .filter(
        ([url, init]) =>
          (url as string).startsWith("https://discord.com") &&
          init?.method === "POST",
      )
      .map(([url]) => url as string);

  it("sends to a thread in an active forum", async () => {
    worldWhereForumIs("active");
    await get(authorized);
    expect(discordPosts()).toEqual([
      expect.stringContaining(`/channels/${THREAD}/messages`),
    ]);
  });

  it.each([
    ["has no row", undefined],
    ["is removed", "removed"],
    ["is unavailable", "unavailable"],
  ])("sends nothing when the forum %s", async (_label, status) => {
    worldWhereForumIs(status);
    await get(authorized);
    expect(discordPosts()).toEqual([]);
  });

  it("has the run's time limit for each operation", async () => {
    worldWhereForumIs("active");
    await get(authorized);
    expect(clients.options).toEqual([
      expect.objectContaining({
        budget: { operationMs: DISCORD_OPERATION_MS },
      }),
    ]);
  });
});

describe("deployment settings", () => {
  const vercel = JSON.parse(
    readFileSync(join(ROOT, "vercel.json"), "utf8"),
  ) as {
    crons: { path: string; schedule: string }[];
    functions: Record<string, { maxDuration: number }>;
  };
  const maxSeconds =
    vercel.functions["api/cron/reminders.ts"]?.maxDuration ?? 0;

  it("schedules a morning run and a recovery run of this endpoint", () => {
    expect(vercel.crons).toEqual([
      { path: "/api/cron/reminders", schedule: "0 14 * * *" },
      { path: "/api/cron/reminders", schedule: "0 16 * * *" },
    ]);
  });

  it("leaves more than the stale claim age between the two crons", () => {
    // A claim left by a failed morning run must be stale by the recovery run. Hobby
    // fires anywhere in the hour, so only one started by 15:00 is sure to be.
    expect(16 - 14).toBeGreaterThan(STALE_CLAIM_MS / 3_600_000);
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

  it("lists this endpoint in the deploy check", () => {
    const workflow = readFileSync(
      join(ROOT, ".github", "workflows", "deploy-check.yml"),
      "utf8",
    );
    expect(workflow).toContain("./api/cron/reminders.func");
  });
});
