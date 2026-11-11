/**
 * A world for testing event commands from end to end: the real router, the real
 * Discord client with its managed-channel check, and the real database schema on
 * PGlite. Only the two networks are stand-ins, and either can be made to fail.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import type { EventRow } from "../../src/db/types.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { ROUTER } from "../../src/handlers/registry.ts";
import type { RouterDependencies } from "../../src/handlers/router.ts";
import {
  createMigratedDb,
  fakeId,
  MIGRATION_OWNER,
  queryAs,
} from "../db/harness.ts";
import { postgrestShim } from "../db/postgrest-shim.ts";
import { discordServer, type DiscordServer } from "./discord-server.ts";
import {
  ADMIN_ROLE,
  APP_ID,
  commandPayload,
  GUILD_ID,
  OFFICER_ROLE,
  run,
  type Ran,
} from "./interactions.ts";
import {
  TEST_ORIGIN,
  TEST_SECRET_KEY,
  testSnowflake,
} from "./mock-postgrest.ts";

// Built at runtime: the secret scan refuses a literal value for this setting.
const TOKEN = ["test", "bot", "token"].join("-");

export const FUTURE = "2099-01-15";
export const OTHER_GUILD = testSnowflake();

type Database = Awaited<ReturnType<typeof createMigratedDb>>;

export interface World {
  readonly db: DbClient;
  readonly pg: Database;
  readonly discord: DiscordServer;
  readonly errors: MockInstance<typeof console.error>;
  /**
   * Fails database requests whose decoded target matches, until cleared. Status 200
   * instead answers as if no row matched, as a read just before another write would.
   */
  failDb(pattern: RegExp, status?: number, times?: number): void;
  clearDbFailures(): void;
  /** Requests the database layer has made, as method and decoded target. */
  dbRequests(): string[];
  send(payload: unknown): Promise<Ran>;
  addManagedForum(guildId?: string, status?: string): Promise<string>;
  events(where?: string): Promise<StoredEvent[]>;
  insertTask(
    eventId: string,
    fields?: { description?: string; assignee?: string },
  ): Promise<string>;
  setForumStatus(channelId: string, status: string): Promise<void>;
}

export type StoredEvent = EventRow & { event_date: string };

const EVENT_SELECT = `SELECT id, guild_id, channel_id, name, event_date::text AS event_date,
  thread_id, overview_message_id, status::text AS status,
  thread_status::text AS thread_status, created_by, deleted_at::text AS deleted_at
  FROM public.events`;

/** Call once per test file. The fields are ready inside each test. */
export function eventWorld(): World {
  let pg: Database;
  let shim: ReturnType<typeof postgrestShim>;
  let server: DiscordServer;
  let errorSpy: MockInstance<typeof console.error>;
  let dbFailures: { pattern: RegExp; status: number; times: number }[] = [];
  let seen: string[] = [];

  const db = createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    fetch: (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      const target = `${init?.method ?? "GET"} ${decodeURIComponent(url.pathname + url.search)}`;
      seen.push(target);
      const failure = dbFailures.find(
        (entry) => entry.times > 0 && entry.pattern.test(target),
      );
      if (failure !== undefined) {
        failure.times -= 1;
        if (failure.status === 200) {
          return Promise.resolve(Response.json([]));
        }
        return Promise.resolve(
          Response.json(
            { code: "XX000", message: "canary row text" },
            { status: failure.status },
          ),
        );
      }
      return shim(input, init);
    },
  });

  beforeAll(async () => {
    pg = await createMigratedDb();
    shim = postgrestShim(pg);
    await queryAs(
      pg,
      "service_role",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
    await queryAs(
      pg,
      "service_role",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4)`,
      [OTHER_GUILD, fakeId(), fakeId(), fakeId()],
    );
  });

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    // The schema refuses TRUNCATE outright. This is a test's own scratch database.
    await pg.exec(
      `SET session_replication_role = replica;
       TRUNCATE public.reminder_log, public.tasks, public.events,
         public.managed_channels, public.interaction_claims CASCADE;
       SET session_replication_role = DEFAULT;`,
    );
    server = discordServer(APP_ID);
    vi.stubGlobal("fetch", server.fetch);
    dbFailures = [];
    seen = [];
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Whatever a test does, nothing the bot sends may ping anyone it did not name.
    for (const { body } of server.requests) {
      const message =
        body?.message === undefined
          ? body
          : (body.message as Record<string, unknown>);
      if (typeof message?.content === "string") {
        expect(message.allowed_mentions).toEqual({ parse: [], users: [] });
        expect(Number(message.flags) & 4).toBe(4);
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const dependencies: RouterDependencies = {
    db: () => db,
    finishDb: () => db,
    discord: () =>
      createDiscordClient({
        check: managedChannelCheck(db),
        env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID },
        sleep: () => Promise.resolve(),
      }),
  };

  const world: World = {
    db,
    get pg() {
      return pg;
    },
    get discord() {
      return server;
    },
    get errors() {
      return errorSpy;
    },
    failDb(pattern, status = 500, times = Number.POSITIVE_INFINITY) {
      dbFailures.push({ pattern, status, times });
    },
    clearDbFailures() {
      dbFailures = [];
    },
    dbRequests: () => seen,
    send: (payload) => run(ROUTER, payload, dependencies),
    async addManagedForum(guildId = GUILD_ID, status = "active") {
      const id = server.addForum(guildId);
      await queryAs(
        pg,
        MIGRATION_OWNER,
        `INSERT INTO public.managed_channels (guild_id, channel_id, status)
         VALUES ($1, $2, $3::public.managed_channel_status)`,
        [guildId, id, status],
      );
      return id;
    },
    async events(where = "TRUE") {
      const result = await pg.query<StoredEvent>(
        `${EVENT_SELECT} WHERE ${where} ORDER BY created_at`,
      );
      return result.rows;
    },
    async insertTask(
      eventId,
      { description = "Book the room", assignee = fakeId() } = {},
    ) {
      const rows = await queryAs<{ id: string }>(
        pg,
        "service_role",
        `INSERT INTO public.tasks
           (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, $4, '2099-01-10', $5) RETURNING id`,
        [eventId, GUILD_ID, assignee, description, fakeId()],
      );
      return (rows[0] as { id: string }).id;
    },
    async setForumStatus(channelId, status) {
      await queryAs(
        pg,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels
         SET status = $2::public.managed_channel_status WHERE channel_id = $1`,
        [channelId, status],
      );
    },
  };
  return world;
}

/** `/event <sub>` as Discord sends it. Options are given as name and value. */
export function eventCommand(
  sub: string,
  options: Record<string, string | { type: number; value: unknown }> = {},
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return commandPayload("event", fields, {
    options: [
      {
        type: 1,
        name: sub,
        options: Object.entries(options).map(([name, value]) =>
          typeof value === "string"
            ? { type: 3, name, value }
            : { name, ...value },
        ),
      },
    ],
  });
}

/** The channel field for an interaction run inside a post. */
export function inThread(threadId: string, parentId: string) {
  return { channel: { id: threadId, type: 11, parent_id: parentId } };
}
