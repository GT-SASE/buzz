/**
 * A world for testing event commands from end to end: the real router, the real
 * Discord client with its managed-channel check, and the real database schema on
 * PGlite. Only the two networks are stand-ins, and either can be made to fail.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  type Mock,
} from "bun:test";
import { pgliteSql, serverError } from "./sql-client.ts";
import { asFetch } from "./stubs.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import type { EventRow } from "../../src/db/types.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { ROUTER } from "../../src/handlers/registry.ts";
import type { RouterDependencies } from "../../src/handlers/router.ts";
import {
  createMigratedDb,
  HOOK_TIMEOUT_MS,
  MIGRATION_OWNER,
  queryAs,
} from "../db/harness.ts";
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
import { fakeId } from "./ids.ts";

const TOKEN = "test-bot-token";

export const FUTURE = "2099-01-15";
export const OTHER_GUILD = fakeId();

type Database = Awaited<ReturnType<typeof createMigratedDb>>;

export interface World {
  readonly db: DbClient;
  readonly pg: Database;
  readonly discord: DiscordServer;
  readonly errors: Mock<typeof console.error>;
  /**
   * Fails database requests whose decoded target matches, until cleared. Status 200
   * instead answers as if no row matched, as a read just before another write would. A
   * statement has the target `SQL <its text on one line>`.
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
  /**
   * Lets this test's messages ping these users and roles, and no others. Every other
   * test may ping nobody at all.
   */
  allowPings(pings: { users?: string[]; roles?: string[] }): void;
}

type StoredEvent = EventRow & { event_date: string };

const EVENT_SELECT = `SELECT id, guild_id, channel_id, name, event_date::text AS event_date,
  thread_id, overview_message_id, status::text AS status,
  thread_status::text AS thread_status, created_by, deleted_at::text AS deleted_at
  FROM public.events`;

/** Call once per test file. The fields are ready inside each test. */
export function eventWorld(): World {
  let pg: Database;
  let server: DiscordServer;
  let errorSpy: Mock<typeof console.error>;
  let dbFailures: { pattern: RegExp; status: number; times: number }[] = [];
  let seen: string[] = [];
  let allowed = { users: new Set<string>(), roles: new Set<string>() };

  const db = createDbClient(
    pgliteSql(
      () => pg,
      ({ sql }) => {
        // On one line, so a pattern can match across the statement's line breaks.
        const target = `SQL ${sql.replace(/\s+/g, " ").trim()}`;
        seen.push(target);
        const failure = dbFailures.find(
          (entry) => entry.times > 0 && entry.pattern.test(target),
        );
        if (failure === undefined) {
          return undefined;
        }
        failure.times -= 1;
        return failure.status === 200 ? { rows: [] } : serverError("XX000");
      },
    ),
  );

  beforeAll(async () => {
    pg = await createMigratedDb();
    await queryAs(
      pg,
      "bot_app",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, NULL, NULL, NULL, NULL)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
    await queryAs(
      pg,
      "bot_app",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, NULL, NULL, NULL, NULL)`,
      [OTHER_GUILD, fakeId(), fakeId(), fakeId()],
    );
  }, HOOK_TIMEOUT_MS);

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
    spyOn(globalThis, "fetch").mockImplementation(asFetch(server.fetch));
    dbFailures = [];
    seen = [];
    allowed = { users: new Set(), roles: new Set() };
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Whatever a test does, nothing the bot sends may ping anyone it did not name.
    for (const { body } of server.requests) {
      const message =
        body?.message === undefined
          ? body
          : (body.message as Record<string, unknown>);
      if (typeof message?.content === "string") {
        const mentions = message.allowed_mentions as {
          parse?: string[];
          users: string[];
          roles?: string[];
        };
        const named = {
          users: mentions.users.filter((id) => allowed.users.has(id)),
          ...(mentions.roles === undefined
            ? {}
            : { roles: mentions.roles.filter((id) => allowed.roles.has(id)) }),
        };
        expect(mentions).toEqual({ parse: [], ...named });
        expect(Number(message.flags) & 4).toBe(4);
      }
    }
    // test/support/setup.ts then restores the spy and fetch.
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
        "bot_app",
        `INSERT INTO public.tasks
           (event_id, guild_id, assignee_id, description, due_date, created_by)
         VALUES ($1, $2, $3, $4, '2099-01-10', $5) RETURNING id`,
        [eventId, GUILD_ID, assignee, description, fakeId()],
      );
      return (rows[0] as { id: string }).id;
    },
    allowPings({ users = [], roles = [] }) {
      allowed = { users: new Set(users), roles: new Set(roles) };
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
