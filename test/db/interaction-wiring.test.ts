/**
 * The Discord client the interactions function really builds, from the endpoint down.
 * Other tests build their own client with their own check, so only this shows that
 * liveDependencies gives its client the check that reads the live forum row.
 */

import { generateKeyPairSync, sign } from "node:crypto";
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
import {
  TEST_ORIGIN,
  TEST_SECRET_KEY,
  testSnowflake,
} from "../support/mock-postgrest.ts";
import {
  createMigratedDb,
  fakeId,
  MIGRATION_OWNER,
  queryAs,
} from "./harness.ts";
import { postgrestShim } from "./postgrest-shim.ts";

const pending = vi.hoisted(() => ({ work: [] as Promise<unknown>[] }));

vi.mock("@vercel/functions", () => ({
  waitUntil: (work: Promise<unknown>) => {
    pending.work.push(work);
  },
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
  const person = testSnowflake();
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
    "service_role",
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
    await queryAs(
      database,
      "service_role",
      `SELECT public.apply_role_bindings($1, 0, $2, $3, $4)`,
      [GUILD_ID, fakeId(), OFFICER_ROLE, ADMIN_ROLE],
    );
  });

  afterAll(() => database.close());

  beforeEach(() => {
    pending.work = [];
    discord = discordServer(APP_ID);
    vi.stubEnv(
      "DISCORD_PUBLIC_KEY",
      publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("hex"),
    );
    vi.stubEnv("DISCORD_APP_ID", APP_ID);
    vi.stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
    vi.stubEnv("DISCORD_BOT_TOKEN", ["test", "bot", "token"].join("-"));
    vi.stubEnv("SUPABASE_URL", TEST_ORIGIN);
    vi.stubEnv("SUPABASE_SECRET_KEY", TEST_SECRET_KEY);
    const shim = postgrestShim(database);
    vi.stubGlobal("fetch", ((input, init) =>
      (typeof input === "string" || input instanceof URL
        ? String(input)
        : input.url
      ).startsWith(TEST_ORIGIN)
        ? shim(input, init)
        : discord.fetch(input, init)) satisfies typeof fetch);
    // The router logs a failed send's type, which is what the second test causes.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
