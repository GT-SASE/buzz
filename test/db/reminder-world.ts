/**
 * A migrated database and a Discord stand-in at `fetch` for the reminder run tests. The
 * run itself is real, so the database's own functions decide every claim and only the
 * network is mocked.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import {
  runReminders,
  type RunLimits,
  type RunResult,
} from "../../src/reminders/run.ts";
import { messageBody, type MessageBody } from "../support/json.ts";
import { pgliteSql, type Intercept } from "../support/sql-client.ts";
import { stubGlobal } from "../support/stubs.ts";
import {
  insertGuild,
  type GuildFixture,
  type WorkflowGuildFixture,
} from "./fixtures.ts";
import { createMigratedDb, fakeId, present } from "./harness.ts";

const API = "https://discord.com/api/v10";

export type Sent = MessageBody & { threadId: string };

type Answer = Response | undefined;

export interface ReminderWorld {
  readonly database: PGlite;
  readonly db: DbClient;
  /** Lets a test answer, fail or watch one statement. */
  sqlGate: Intercept;
  /** Lets a test refuse or react to one Discord request. */
  discordGate: (
    method: string,
    path: string,
    message: Sent | undefined,
  ) => Answer | Promise<Answer>;
  requests: { method: string; path: string }[];
  /** The messages Discord took. */
  sent: Sent[];
  /** What a GET of each forum and thread returns. */
  channels: Map<string, Record<string, unknown>>;
  logLines: string[];
  posts(): { method: string; path: string }[];
  client(): ReturnType<typeof createDiscordClient>;
  run(
    guilds: readonly GuildFixture[],
    options?: { now?: Date | (() => Date); limits?: Partial<RunLimits> },
  ): Promise<RunResult>;
  /** A guild in this zone, UTC unless told, so test dates and "today" agree. */
  guildInZone(timezone?: string): Promise<WorkflowGuildFixture>;
  /** A thread under the guild's forum, as Discord will describe it. */
  addThread(guild: GuildFixture): string;
  jobRow(jobName?: string): Promise<{
    status: string;
    results: Record<string, unknown>;
    error: string | null;
  }>;
}

/** Days from the date a run plans for in a UTC guild: that of its slot's start. */
export function dateOffset(days: number): string {
  return new Date(slotStart(new Date()) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Migrates a database once for the file, and before each test gives a fresh Discord
 * stand-in and leaves earlier tests' guilds with nothing to remind or check.
 */
export function useReminderWorld(): ReminderWorld {
  let database: PGlite | undefined;
  let db: DbClient | undefined;

  const world: ReminderWorld = {
    get database() {
      return present(database);
    },
    get db() {
      return present(db);
    },
    sqlGate: () => undefined,
    discordGate: () => undefined,
    requests: [],
    sent: [],
    channels: new Map(),
    logLines: [],
    posts: () => world.requests.filter((request) => request.method === "POST"),
    client: () =>
      createDiscordClient({
        check: managedChannelCheck(world.db),
        env: { DISCORD_BOT_TOKEN: "unit-test-token", DISCORD_APP_ID: fakeId() },
        sleep: () => Promise.resolve(),
      }),
    run: (guilds, { now, limits } = {}) =>
      runReminders({
        db: world.db,
        client: world.client(),
        allowedGuildIds: new Set(guilds.map((guild) => guild.guildId)),
        log: (line) => world.logLines.push(line),
        ...(now === undefined
          ? {}
          : { now: typeof now === "function" ? now : () => now }),
        ...(limits === undefined ? {} : { limits }),
      }),
    async guildInZone(timezone = "UTC") {
      const guild = await insertGuild(world.database);
      await world.database.query(
        `UPDATE public.guild_config SET timezone = $2 WHERE guild_id = $1`,
        [guild.guildId, timezone],
      );
      world.channels.set(guild.channelId, {
        id: guild.channelId,
        type: 15,
        guild_id: guild.guildId,
      });
      return guild;
    },
    addThread(guild) {
      const threadId = fakeId();
      world.channels.set(threadId, {
        id: threadId,
        type: 11,
        guild_id: guild.guildId,
        parent_id: guild.channelId,
      });
      return threadId;
    },
    async jobRow(jobName = "reminders") {
      const { rows } = await world.database.query<{
        status: string;
        results: Record<string, unknown>;
        error: string | null;
      }>(
        `SELECT status, results, error FROM public.job_runs
         WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1`,
        [jobName],
      );
      return present(rows[0]);
    },
  };

  async function answer(input: string, init?: RequestInit) {
    if (!input.startsWith(API)) {
      throw new Error(`Unexpected request to ${input}`);
    }
    const path = input.slice(API.length);
    const method = init?.method ?? "GET";
    world.requests.push({ method, path });
    const id = /^\/channels\/([0-9]+)/.exec(path)?.[1] ?? "";
    let message: Sent | undefined;
    if (method === "POST") {
      message = { threadId: id, ...messageBody(init?.body) };
      if (message.flags === undefined) {
        throw new Error("a reminder must set its flags");
      }
    }
    const given = await world.discordGate(method, path, message);
    if (given !== undefined) {
      return given;
    }
    if (message !== undefined) {
      world.sent.push(message);
      return Response.json({ id: fakeId() });
    }
    return Response.json(
      world.channels.get(id) ?? { id, type: 15, guild_id: "0" },
    );
  }

  beforeAll(async () => {
    database = await createMigratedDb();
    db = createDbClient(pgliteSql(database, (call) => world.sqlGate(call)));
  });

  afterAll(() => database?.close());

  beforeEach(async () => {
    world.sqlGate = () => undefined;
    world.discordGate = () => undefined;
    world.requests = [];
    world.sent = [];
    world.channels = new Map();
    world.logLines = [];
    stubGlobal("fetch", answer);
    await world.database.exec(`
      UPDATE public.tasks SET deleted_at = now() WHERE deleted_at IS NULL;
      UPDATE public.managed_channels SET status = 'removed';
      DELETE FROM public.reminder_log;
      DELETE FROM public.event_reminder_log;
      DELETE FROM public.job_runs;
    `);
  });

  return world;
}
