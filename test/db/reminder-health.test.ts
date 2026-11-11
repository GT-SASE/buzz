/** The health check and freshness flags against the real schema, with Discord mocked. */

import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { runDailyJobs } from "../../src/reminders/daily.ts";
import {
  MAX_RUN_AGE_MS,
  jobFreshness,
  runHealthCheck,
} from "../../src/reminders/health.ts";
import { managedChannelCheck } from "../../src/reminders/run.ts";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import { TEST_ORIGIN, TEST_SECRET_KEY } from "../support/mock-postgrest.ts";
import { insertGuild, type GuildFixture } from "./fixtures.ts";
import { createMigratedDb, fakeId, present } from "./harness.ts";
import { postgrestShim } from "./postgrest-shim.ts";

const API = "https://discord.com/api/v10";
const TOKEN = ["unit", "test", "token"].join("-");

let database: PGlite;
let db: DbClient;
let dbGate: (url: string) => Response | undefined;
let requests: { method: string; path: string }[];
let answers: Map<string, () => Response>;
let logLines: string[];

function client() {
  return createDiscordClient({
    check: managedChannelCheck(db),
    env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: fakeId() },
    sleep: () => Promise.resolve(),
  });
}

function health(
  allowed: readonly GuildFixture[],
  options: { now?: () => Date; deadlineMs?: number } = {},
) {
  return runHealthCheck({
    db,
    client: client(),
    allowedGuildIds: new Set(allowed.map((guild) => guild.guildId)),
    log: (line) => logLines.push(line),
    ...options,
  });
}

function forum(guild: GuildFixture): void {
  answers.set(guild.channelId, () =>
    Response.json({ id: guild.channelId, type: 15, guild_id: guild.guildId }),
  );
}

async function channelStatus(guild: GuildFixture): Promise<string | undefined> {
  const { rows } = await database.query<{ status: string }>(
    `SELECT status FROM public.managed_channels WHERE guild_id = $1`,
    [guild.guildId],
  );
  return rows[0]?.status;
}

async function latestRow() {
  const { rows } = await database.query<{
    status: string;
    results: Record<string, number>;
    error: string | null;
  }>(
    `SELECT status, results, error FROM public.job_runs
     WHERE job_name = 'health_check' ORDER BY started_at DESC LIMIT 1`,
  );
  return present(rows[0]);
}

async function succeededRun(jobName: string, hoursAgo: number): Promise<void> {
  await database.query(
    `INSERT INTO public.job_runs (job_name, status, started_at, heartbeat_at, finished_at)
     VALUES ($1, 'succeeded', now() - make_interval(hours => $2),
             now() - make_interval(hours => $2), now() - make_interval(hours => $2))`,
    [jobName, hoursAgo],
  );
}

beforeAll(async () => {
  database = await createMigratedDb();
  const shim = postgrestShim(database);
  db = createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    fetch: (input, init) => {
      const answer = dbGate(input as string);
      return answer === undefined ? shim(input, init) : Promise.resolve(answer);
    },
  });
});

afterAll(() => database.close());

beforeEach(async () => {
  dbGate = () => undefined;
  requests = [];
  answers = new Map();
  logLines = [];
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    if (!input.startsWith(API)) {
      throw new Error("Unexpected request");
    }
    const path = input.slice(API.length);
    requests.push({ method: init?.method ?? "GET", path });
    const id = path.split("/")[2] ?? "";
    const answer = answers.get(id);
    return Promise.resolve(
      answer === undefined
        ? Response.json({ code: 0 }, { status: 500 })
        : answer(),
    );
  });
  await database.exec(`
    DELETE FROM public.job_runs;
    UPDATE public.managed_channels SET status = 'removed';
  `);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("channel checks", () => {
  it("makes one GET per channel and posts nothing", async () => {
    const one = await insertGuild(database);
    const two = await insertGuild(database);
    forum(one);
    forum(two);

    const result = await health([one, two]);

    expect(result.status).toBe("succeeded");
    expect(requests.map((request) => request.path).sort()).toEqual(
      [`/channels/${one.channelId}`, `/channels/${two.channelId}`].sort(),
    );
    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(await latestRow()).toMatchObject({
      status: "succeeded",
      results: { channels_checked: 2, channels_ok: 2 },
    });
  });

  it("disables a channel on an explicit Unknown Channel", async () => {
    const guild = await insertGuild(database);
    answers.set(guild.channelId, () =>
      Response.json({ code: 10003 }, { status: 404 }),
    );
    await health([guild]);
    expect(await channelStatus(guild)).toBe("unavailable");
    expect((await latestRow()).results).toMatchObject({ channels_gone: 1 });
  });

  it.each([
    ["a 404 with no code", () => new Response("no", { status: 404 })],
    ["another 404 code", () => Response.json({ code: 10008 }, { status: 404 })],
    ["an outage", () => Response.json({ code: 0 }, { status: 503 })],
    [
      "a route rate limit",
      () => Response.json({ retry_after: 500 }, { status: 429 }),
    ],
  ])("does not disable a channel on %s", async (_label, answer) => {
    const guild = await insertGuild(database);
    answers.set(guild.channelId, answer);
    const result = await health([guild]);
    expect(result.status).toBe("succeeded");
    expect(await channelStatus(guild)).toBe("active");
    expect((await latestRow()).results).toMatchObject({ channels_unknown: 1 });
  });

  it.each([50001, 50013])(
    "flags a channel on %i but does not disable it",
    async (code) => {
      const guild = await insertGuild(database);
      answers.set(guild.channelId, () =>
        Response.json({ code }, { status: 403 }),
      );
      await health([guild]);
      expect(await channelStatus(guild)).toBe("active");
      expect((await latestRow()).results).toMatchObject({
        channels_inaccessible: 1,
      });
    },
  );

  it("flags a channel in the wrong guild or of the wrong type", async () => {
    const wrongGuild = await insertGuild(database);
    const wrongType = await insertGuild(database);
    answers.set(wrongGuild.channelId, () =>
      Response.json({ type: 15, guild_id: fakeId() }),
    );
    answers.set(wrongType.channelId, () =>
      Response.json({ type: 0, guild_id: wrongType.guildId }),
    );
    await health([wrongGuild, wrongType]);
    expect(await channelStatus(wrongGuild)).toBe("active");
    expect(await channelStatus(wrongType)).toBe("active");
    expect((await latestRow()).results).toMatchObject({
      channels_wrong_guild: 1,
      channels_not_forum: 1,
      channels_ok: 0,
    });
  });

  it("stops on the first 401 after exactly one request", async () => {
    const one = await insertGuild(database);
    const two = await insertGuild(database);
    answers.set(one.channelId, () => new Response("{}", { status: 401 }));
    answers.set(two.channelId, () => new Response("{}", { status: 401 }));
    const result = await health([one, two]);
    expect(requests).toHaveLength(1);
    expect(result).toMatchObject({
      status: "failed",
      error: "discord_unauthorized:401",
    });
    expect(await latestRow()).toMatchObject({
      status: "failed",
      error: "discord_unauthorized:401",
    });
  });

  it("makes no request for a guild no longer allowed", async () => {
    const guild = await insertGuild(database);
    await health([]);
    expect(requests).toEqual([]);
    expect(await channelStatus(guild)).toBe("active");
    expect((await latestRow()).results).toMatchObject({
      guilds_not_allowed: 1,
    });
  });

  it("stops at the deadline and records what it did not reach", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    await health([guild], { deadlineMs: Date.now() - 1 });
    expect(requests).toEqual([]);
    expect((await latestRow()).results).toMatchObject({
      channels_not_reached: 1,
    });
  });

  it("runs once a day", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    await health([guild]);
    requests = [];
    expect((await health([guild])).status).toBe("duplicate");
    expect(requests).toEqual([]);
  });

  it("stores no text from a database failure", async () => {
    const canary = "canary-row-text";
    dbGate = (url) =>
      url.includes("/managed_channels?")
        ? Response.json(
            { code: "23514", message: canary, details: canary },
            { status: 400 },
          )
        : undefined;
    const result = await health([]);
    expect(result).toMatchObject({
      status: "failed",
      error: "constraint:23514",
    });
    const row = await latestRow();
    expect(row.error).toBe("constraint:23514");
    expect(JSON.stringify(row)).not.toContain(canary);
    expect(JSON.stringify(logLines)).not.toContain(canary);
    for (const value of Object.values(row.results)) {
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });
});

describe("freshness", () => {
  it("is fresh just after a run", async () => {
    await succeededRun("reminders", 1);
    expect(await jobFreshness(db, "reminders", new Date())).toEqual({
      state: "fresh",
      ageHours: 1,
    });
  });

  it("is stale past the limit, and never when no run has succeeded", async () => {
    expect(await jobFreshness(db, "reminders", new Date())).toEqual({
      state: "never",
    });
    await succeededRun("reminders", 30);
    const now = new Date();
    expect(await jobFreshness(db, "reminders", now)).toEqual({
      state: "stale",
      ageHours: 30,
    });
    expect(MAX_RUN_AGE_MS).toBe(26 * 3_600_000);
  });

  it("counts only succeeded runs", async () => {
    await succeededRun("reminders", 30);
    await database.exec(
      `INSERT INTO public.job_runs (job_name, status, finished_at, error)
       VALUES ('reminders', 'failed', now(), 'discord_unauthorized:401')`,
    );
    expect(await jobFreshness(db, "reminders", new Date())).toMatchObject({
      state: "stale",
    });
  });

  it("does not report a job as fine when it cannot read job_runs", async () => {
    dbGate = (url) =>
      url.includes("/job_runs?")
        ? Response.json({ code: "XX000" }, { status: 500 })
        : undefined;
    expect(await jobFreshness(db, "reminders", new Date())).toEqual({
      state: "unknown",
    });
  });

  it("flags a stale reminders job in the health check's row", async () => {
    await succeededRun("reminders", 50);
    await succeededRun("health_check", 24);
    await health([]);
    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 1,
      reminders_age_hours: 50,
      health_check_stale: 0,
    });
    expect(logLines.join("\n")).toContain("reminders");
  });

  it("flags a job that has never run", async () => {
    await health([]);
    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 1,
      reminders_never_run: 1,
      health_check_stale: 1,
      health_check_never_run: 1,
    });
  });

  it("does not trust a success dated in the future", async () => {
    await succeededRun("reminders", 2);
    const hoursBefore = new Date(Date.now() - 3 * 3_600_000);
    expect(await jobFreshness(db, "reminders", hoursBefore)).toEqual({
      state: "future",
    });
  });

  it("allows for a small difference between clocks", async () => {
    await succeededRun("reminders", 0);
    const minuteBefore = new Date(Date.now() - 60_000);
    expect(await jobFreshness(db, "reminders", minuteBefore)).toEqual({
      state: "fresh",
      ageHours: 0,
    });
  });

  it("stores a future-dated success as stale", async () => {
    await succeededRun("reminders", 30);
    await succeededRun("health_check", 30);
    await health([], { now: () => new Date(Date.now() - 40 * 3_600_000) });
    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 1,
      reminders_future_dated: 1,
      health_check_stale: 1,
      health_check_future_dated: 1,
    });
  });

  it("copies out what the latest reminder run left for a person to see", async () => {
    await succeededRun("health_check", 24);
    await insertFinishedJobRun(database, {
      status: "succeeded",
      results: JSON.stringify({
        deferred_cap: 4,
        threads_held: 2,
        events_stopped: 1,
        threads_missing: 0,
        messages_sent: 100,
      }),
    });

    await health([]);

    const { results } = await latestRow();
    expect(results).toMatchObject({
      reminders_deferred_cap: 4,
      reminders_threads_held: 2,
      reminders_events_stopped: 1,
    });
    expect(results).not.toHaveProperty("reminders_threads_missing");
    expect(logLines.join("\n")).toContain("deferred_cap 4");
  });

  it("does not flag fresh jobs", async () => {
    await succeededRun("reminders", 2);
    await succeededRun("health_check", 24);
    await health([]);
    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 0,
      health_check_stale: 0,
    });
    expect(logLines).toEqual([]);
  });
});

describe("one invocation", () => {
  function daily(guild: GuildFixture, discord = client()) {
    return runDailyJobs({
      db,
      client: discord,
      allowedGuildIds: new Set([guild.guildId]),
    });
  }

  it("clears interaction claims older than a day", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    const old = fakeId();
    await database.query(
      `INSERT INTO public.interaction_claims (interaction_id, claimed_at)
       VALUES ($1, now() - interval '2 days')`,
      [old],
    );

    expect(await daily(guild)).toBe(true);

    const { rows } = await database.query(
      `SELECT 1 FROM public.interaction_claims WHERE interaction_id = $1`,
      [old],
    );
    expect(rows).toEqual([]);
  });

  it("shows a gap that this invocation's own reminder run has just ended", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    await succeededRun("reminders", 40);
    await succeededRun("health_check", 40);

    expect(await daily(guild)).toBe(true);

    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 1,
      reminders_age_hours: 40,
    });
  });

  it("does not flag a reminder job that ran yesterday", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    await succeededRun("reminders", 24);
    await succeededRun("health_check", 24);

    expect(await daily(guild)).toBe(true);

    expect((await latestRow()).results).toMatchObject({
      reminders_stale: 0,
      reminders_age_hours: 24,
    });
  });

  it("runs reminders and then the health check", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    expect(await daily(guild)).toBe(true);
    const { rows } = await database.query<{ job_name: string; status: string }>(
      `SELECT job_name, status FROM public.job_runs ORDER BY job_name`,
    );
    expect(rows).toEqual([
      { job_name: "health_check", status: "succeeded" },
      { job_name: "reminders", status: "succeeded" },
    ]);
  });

  it("shares one client, so a refused token is not tried again", async () => {
    const guild = await insertGuild(database);
    answers.set(guild.channelId, () => new Response("{}", { status: 401 }));
    const threadId = fakeId();
    answers.set(threadId, () => new Response("{}", { status: 401 }));
    const event = await database.query<{ id: string }>(
      `INSERT INTO public.events
         (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
       VALUES ($1, $2, 'Meeting', '2030-01-15', $3, $4, 'active') RETURNING id`,
      [guild.guildId, guild.channelId, fakeId(), threadId],
    );
    await database.query(
      `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
       VALUES ($1, $2, $3, 'Book', $4, $5)`,
      [
        present(event.rows[0]).id,
        guild.guildId,
        fakeId(),
        new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
        fakeId(),
      ],
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await daily(guild)).toBe(false);

    expect(requests).toHaveLength(1);
    const { rows } = await database.query<{ error: string }>(
      `SELECT error FROM public.job_runs WHERE job_name = 'health_check'`,
    );
    expect(rows).toEqual([{ error: "discord_unauthorized:401" }]);
    await database.exec(`UPDATE public.tasks SET deleted_at = now()`);
    vi.restoreAllMocks();
  });

  it("reports a failure when only the health check failed", async () => {
    const guild = await insertGuild(database);
    answers.set(guild.channelId, () => new Response("{}", { status: 401 }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await daily(guild)).toBe(false);
    vi.restoreAllMocks();
  });

  it("leaves the health check for the next cron when out of time", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    const base = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(base);
    clock.mockReturnValue(base + 41_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await daily(guild)).toBe(true);

    expect(requests).toEqual([]);
    const { rows } = await database.query(
      `SELECT 1 FROM public.job_runs WHERE job_name = 'health_check'`,
    );
    expect(rows).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).toContain("out of time");
    vi.restoreAllMocks();
  });

  it("does not count a duplicate as a failure", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    expect(await daily(guild)).toBe(true);
    requests = [];
    expect(await daily(guild)).toBe(true);
    expect(requests).toEqual([]);
  });
});
