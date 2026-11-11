/**
 * A run that throws outside the per-event handling. This is the last catch in
 * runReminders: if it recorded nothing, the crashed run would count as a success and
 * the lock would refuse the recovery cron, so that day's reminders would be lost.
 */

import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck, runReminders } from "../../src/reminders/run.ts";
import { TEST_ORIGIN, TEST_SECRET_KEY } from "../support/mock-postgrest.ts";
import { insertEvent, insertGuild, type GuildFixture } from "./fixtures.ts";
import { createMigratedDb, fakeId, queryAs } from "./harness.ts";
import { postgrestShim } from "./postgrest-shim.ts";

const CANARY = "canary-from-a-crashed-run";
const TOKEN = ["unit", "test", "token"].join("-");

let database: PGlite;
let db: DbClient;
let guild: GuildFixture;
let posts: string[];

/** Discord as far as one reminder needs it: the thread's parent, and the send. */
function mockDiscord(threadId: string): void {
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "POST") {
      posts.push(input);
      return Promise.resolve(Response.json({ id: fakeId() }));
    }
    return Promise.resolve(
      Response.json({
        id: threadId,
        type: 11,
        guild_id: guild.guildId,
        parent_id: guild.channelId,
      }),
    );
  });
}

function runWith(now?: () => Date) {
  const logged: string[] = [];
  return {
    logged,
    result: runReminders({
      db,
      client: createDiscordClient({
        check: managedChannelCheck(db),
        env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: fakeId() },
        sleep: () => Promise.resolve(),
      }),
      allowedGuildIds: new Set([guild.guildId]),
      log: (line) => logged.push(line),
      ...(now === undefined ? {} : { now }),
    }),
  };
}

/**
 * The run reads the clock once when it is built and first thing in its work, so a throw
 * on the second read lands in the work and nowhere else.
 */
function clockThatThrowsOnSecondRead(): () => Date {
  let reads = 0;
  return () => {
    reads += 1;
    if (reads === 2) {
      throw new TypeError(CANARY);
    }
    return new Date();
  };
}

beforeAll(async () => {
  database = await createMigratedDb();
  db = createDbClient({
    url: TEST_ORIGIN,
    secretKey: TEST_SECRET_KEY,
    fetch: postgrestShim(database),
  });
  guild = await insertGuild(database);
  await database.query(
    `UPDATE public.guild_config SET timezone = 'UTC' WHERE guild_id = $1`,
    [guild.guildId],
  );
});

afterAll(() => database.close());

beforeEach(async () => {
  posts = [];
  const eventId = await insertEvent(database, guild);
  const threadId = fakeId();
  await database.query(
    `UPDATE public.events SET thread_id = $2, thread_status = 'active' WHERE id = $1`,
    [eventId, threadId],
  );
  const dueDate = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await queryAs(
    database,
    "service_role",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, 'Book the room', $4, $5)`,
    [eventId, guild.guildId, fakeId(), dueDate, fakeId()],
  );
  mockDiscord(threadId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("records a crashed run as failed, and the next run in the slot still sends", async () => {
  const crashed = runWith(clockThatThrowsOnSecondRead());

  expect(await crashed.result).toMatchObject({
    status: "failed",
    error: "unexpected",
  });
  expect(posts).toEqual([]);
  const { rows } = await database.query<{
    status: string;
    error: string | null;
  }>(`SELECT status, error FROM public.job_runs WHERE job_name = 'reminders'`);
  expect(rows).toEqual([{ status: "failed", error: "unexpected" }]);
  expect(JSON.stringify([rows, crashed.logged])).not.toContain(CANARY);

  const recovery = await runWith().result;

  expect(recovery).toMatchObject({ status: "succeeded" });
  expect(posts).toHaveLength(1);
});
