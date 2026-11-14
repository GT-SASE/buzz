/** The health check and freshness flags against the real schema, with Discord mocked. */

import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { pgliteSql } from "../support/sql-client.ts";
import { stubGlobal } from "../support/stubs.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { runDailyJobs } from "../../src/reminders/daily.ts";
import { jobFreshness, runHealthCheck } from "../../src/reminders/health.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { insertFinishedJobRun } from "../support/job-runs-fixture.ts";
import { insertGuild, type GuildFixture } from "./fixtures.ts";
import { createMigratedDb, fakeId, present } from "./harness.ts";

const API = "https://discord.com/api/v10";

let database: PGlite;
let db: DbClient;
let requests: { method: string; path: string }[];
let answers: Map<string, () => Response>;
let logLines: string[];

function client() {
  return createDiscordClient({
    check: managedChannelCheck(db),
    env: { DISCORD_BOT_TOKEN: "unit-test-token", DISCORD_APP_ID: fakeId() },
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

function daily(guild: GuildFixture) {
  return runDailyJobs({
    db,
    client: client(),
    allowedGuildIds: new Set([guild.guildId]),
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
  const { rows } = await database.query<{ results: Record<string, number> }>(
    `SELECT results FROM public.job_runs
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
  db = createDbClient(pgliteSql(database));
});

afterAll(() => database.close());

beforeEach(async () => {
  requests = [];
  answers = new Map();
  logLines = [];
  stubGlobal("fetch", (input: string, init?: RequestInit) => {
    if (!input.startsWith(API)) {
      throw new Error("Unexpected request");
    }
    const path = input.slice(API.length);
    requests.push({ method: init?.method ?? "GET", path });
    const answer = answers.get(path.split("/")[2] ?? "");
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

describe("channel checks", () => {
  it("makes one GET per channel and posts nothing", async () => {
    const one = await insertGuild(database);
    const two = await insertGuild(database);
    forum(one);
    forum(two);

    expect((await health([one, two])).status).toBe("succeeded");

    expect(requests.map((r) => `${r.method} ${r.path}`).sort()).toEqual(
      [
        `GET /channels/${one.channelId}`,
        `GET /channels/${two.channelId}`,
      ].sort(),
    );
    expect((await latestRow()).results).toMatchObject({ channels_ok: 2 });
  });

  it.each([
    ["Unknown Channel", 404, 10003, "unavailable", "channels_gone"],
    ["an outage", 503, 0, "active", "channels_unknown"],
    ["Missing Access", 403, 50001, "active", "channels_inaccessible"],
  ])(
    "on %s, leaves the channel %s",
    async (_label, status, code, after, counter) => {
      const guild = await insertGuild(database);
      answers.set(guild.channelId, () => Response.json({ code }, { status }));
      await health([guild]);
      expect(await channelStatus(guild)).toBe(after);
      expect((await latestRow()).results).toMatchObject({ [counter]: 1 });
    },
  );

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
  });

  it.each([
    ["for a guild no longer allowed", false, "guilds_not_allowed"],
    ["past the deadline", true, "channels_not_reached"],
  ])("makes no request %s", async (_label, allowed, counter) => {
    const guild = await insertGuild(database);
    forum(guild);
    await health(allowed ? [guild] : [], { deadlineMs: allowed ? 0 : 1e15 });
    expect(requests).toEqual([]);
    expect(await channelStatus(guild)).toBe("active");
    expect((await latestRow()).results).toMatchObject({ [counter]: 1 });
  });
});

describe("freshness", () => {
  it("is never, fresh, stale or future-dated", async () => {
    expect(await jobFreshness(db, "reminders", new Date())).toEqual({
      state: "never",
    });
    await succeededRun("reminders", 0);
    // A clock a minute behind the database's still reads it as fresh.
    const minuteBefore = new Date(Date.now() - 60_000);
    expect(await jobFreshness(db, "reminders", minuteBefore)).toEqual({
      state: "fresh",
      ageHours: 0,
    });
    await database.exec(`DELETE FROM public.job_runs`);
    await succeededRun("reminders", 30);
    expect(await jobFreshness(db, "reminders", new Date())).toEqual({
      state: "stale",
      ageHours: 30,
    });
    // A success hours after "now" is not trusted.
    const hoursBefore = new Date(Date.now() - 31 * 3_600_000);
    expect(await jobFreshness(db, "reminders", hoursBefore)).toEqual({
      state: "future",
    });
  });

  it("copies out what the latest reminder run left for a person to see", async () => {
    await succeededRun("health_check", 24);
    await insertFinishedJobRun(database, {
      status: "succeeded",
      results: JSON.stringify({
        deferred_cap: 4,
        events_stopped: 1,
        threads_missing: 0,
        messages_sent: 100,
      }),
    });

    await health([]);

    const { results } = await latestRow();
    expect(results).toMatchObject({
      reminders_deferred_cap: 4,
      reminders_events_stopped: 1,
    });
    expect(results).not.toHaveProperty("reminders_threads_missing");
    expect(logLines.join("\n")).toContain("deferred_cap 4");
  });
});

describe("one invocation", () => {
  it.each([
    [40, 1],
    [24, 0],
  ])(
    "after a reminder run %i hours ago, flags the gap: %i",
    async (hours, stale) => {
      const guild = await insertGuild(database);
      forum(guild);
      await succeededRun("reminders", hours);
      await succeededRun("health_check", hours);

      expect(await daily(guild)).toBe(true);

      expect((await latestRow()).results).toMatchObject({
        reminders_stale: stale,
        reminders_age_hours: hours,
      });
    },
  );

  it("runs reminders then the health check, and a rerun is a duplicate, not a failure", async () => {
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
    expect((await latestRow()).results).toMatchObject({
      health_check_never_run: 1,
    });

    requests = [];
    expect(await daily(guild)).toBe(true);
    expect(requests).toEqual([]);
  });

  it("leaves the health check for the next cron when out of time", async () => {
    const guild = await insertGuild(database);
    forum(guild);
    const base = Date.now();
    spyOn(Date, "now")
      .mockReturnValueOnce(base)
      .mockReturnValue(base + 41_000);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await daily(guild)).toBe(true);

    expect(requests).toEqual([]);
    expect(JSON.stringify(warn.mock.calls)).toContain("out of time");
  });
});
