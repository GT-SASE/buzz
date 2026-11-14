/**
 * The Discord client the interactions function really builds, from the endpoint down.
 * Other tests build their own client with their own check, so only this shows that
 * liveDependencies gives its client the check that reads the live forum row.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { POST } from "../../api/interactions.ts";
import {
  discordServer,
  type DiscordServer,
} from "../support/discord-server.ts";
import {
  ADMIN_ROLE,
  APP_ID,
  commandPayload,
  GUILD_ID,
  member,
  OFFICER_ROLE,
} from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { createMigratedDb, MIGRATION_OWNER, queryAs } from "./harness.ts";
import { pgliteSql, testDatabaseUrl } from "../support/sql-client.ts";
import { stubEnv, stubGlobal } from "../support/stubs.ts";

const pending = { work: [] as Promise<unknown>[] };

void mock.module("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    pending.work.push(work);
  },
}));

/** The migrated database, for the client the function builds from its settings. */
const current = { database: undefined as PGlite | undefined };

void mock.module("../../src/db/neon.ts", () => ({
  neonRunner: () =>
    pgliteSql(() => {
      if (current.database === undefined) {
        throw new Error("the database is not set up");
      }
      return current.database;
    }),
}));

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

let database: PGlite;
let discord: DiscordServer;

function signed(payload: unknown): Request {
  const body = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  return new Request("https://bot.example.test/api/interactions", {
    method: "POST",
    headers: {
      "x-signature-ed25519": sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        privateKey,
      ).toString("hex"),
      "x-signature-timestamp": timestamp,
    },
    body,
  });
}

function assign(eventId: string): Record<string, unknown> {
  const person = fakeId();
  const text = {
    description: "Book the room",
    due: "2099-01-10",
    event: eventId,
  };
  return commandPayload(
    "task",
    { member: member({ roles: [OFFICER_ROLE] }) },
    {
      options: [
        {
          name: "assign",
          type: 1,
          options: [
            { name: "person", type: 6, value: person },
            ...Object.entries(text).map(([name, value]) => ({
              name,
              type: 3,
              value,
            })),
          ],
        },
      ],
      resolved: {
        users: { [person]: { id: person } },
        members: { [person]: {} },
      },
    },
  );
}

/** A forum with an event and its post. */
async function eventWithPost() {
  const forumId = discord.addForum(GUILD_ID);
  await queryAs(
    database,
    MIGRATION_OWNER,
    `INSERT INTO public.managed_channels (guild_id, channel_id, status)
     VALUES ($1, $2, 'active')`,
    [GUILD_ID, forumId],
  );
  const threadId = discord.addThread({
    guild_id: GUILD_ID,
    parent_id: forumId,
  });
  const rows = await queryAs<{ id: string }>(
    database,
    "bot_app",
    `INSERT INTO public.events
       (guild_id, channel_id, name, event_date, created_by, thread_id, thread_status)
     VALUES ($1, $2, 'General meeting', '2099-01-15', $3, $4, 'active')
     RETURNING id`,
    [GUILD_ID, forumId, fakeId(), threadId],
  );
  return { forumId, threadId, eventId: (rows[0] as { id: string }).id };
}

async function assignOn(eventId: string): Promise<void> {
  const response = await POST(signed(assign(eventId)));
  expect(response.status).toBe(200);
  expect(pending.work).toHaveLength(1);
  await Promise.all(pending.work);
}

describe("the client built by liveDependencies", () => {
  beforeAll(async () => {
    database = await createMigratedDb();
    current.database = database;
    await queryAs(
      database,
      "bot_app",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4, NULL, NULL, NULL, NULL)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
  });

  afterAll(() => database.close());

  beforeEach(() => {
    pending.work = [];
    discord = discordServer(APP_ID);
    stubEnv(
      "DISCORD_PUBLIC_KEY",
      publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex"),
    );
    stubEnv("DISCORD_APP_ID", APP_ID);
    stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
    stubEnv("DISCORD_BOT_TOKEN", "test-bot-token");
    stubEnv("DATABASE_URL", testDatabaseUrl());
    // Only Discord is reached over HTTP. The database is the mocked pool above.
    stubGlobal("fetch", discord.fetch);
    // The router logs a failed send's type, which is what the second test causes.
    spyOn(console, "error").mockImplementation(() => undefined);
  });

  const postsIn = (threadId: string) =>
    discord.requests.filter(
      ({ method, path }) =>
        method === "POST" && path.includes(`/channels/${threadId}/messages`),
    );

  it("posts in the event's post while its forum is active", async () => {
    const { threadId, eventId } = await eventWithPost();

    await assignOn(eventId);

    expect(postsIn(threadId)).not.toEqual([]);
  });

  it.each(["removed", "unavailable"])(
    "posts nothing once the forum is %s, and keeps the task",
    async (status) => {
      const { forumId, threadId, eventId } = await eventWithPost();
      await queryAs(
        database,
        MIGRATION_OWNER,
        `UPDATE public.managed_channels
         SET status = $2::public.managed_channel_status WHERE channel_id = $1`,
        [forumId, status],
      );

      await assignOn(eventId);

      expect(postsIn(threadId)).toEqual([]);
      const { rows } = await database.query(
        `SELECT 1 FROM public.tasks WHERE event_id = $1`,
        [eventId],
      );
      expect(rows).toHaveLength(1);
    },
  );
});
