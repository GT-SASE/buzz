/**
 * A run that throws outside the per-event handling. This is the last catch in
 * runReminders: if it recorded nothing, the crashed run would count as a success and
 * the lock would refuse the recovery cron, so that day's reminders would be lost.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { pgliteSql } from "../support/sql-client.ts";
import { stubGlobal } from "../support/stubs.ts";
import { createDbClient, type DbClient } from "../../src/db/client.ts";
import { createDiscordClient } from "../../src/discord/client.ts";
import { managedChannelCheck } from "../../src/handlers/dependencies.ts";
import { runReminders } from "../../src/reminders/run.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import {
  finishEventSteps,
  insertEvent,
  insertGuild,
  type GuildFixture,
} from "./fixtures.ts";
import { createMigratedDb, fakeId, queryAs } from "./harness.ts";

const TOKEN = "unit-test-token";

let database: PGlite;
let db: DbClient;
let guild: GuildFixture;
let posts: string[];

/** Discord as far as one reminder needs it: the thread's parent, and the send. */
function mockDiscord(threadId: string): void {
  stubGlobal("fetch", (input: string, init?: RequestInit) => {
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
  return runReminders({
    db,
    client: createDiscordClient({
      check: managedChannelCheck(db),
      env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: fakeId() },
      sleep: () => Promise.resolve(),
    }),
    allowedGuildIds: new Set([guild.guildId]),
    log: () => undefined,
    ...(now === undefined ? {} : { now }),
  });
}

/**
 * The run reads the clock for its slot, once when it is built and first thing in its work,
 * so a throw on the third read lands in the work and nowhere else.
 */
function clockThatThrowsOnThirdRead(): () => Date {
  let reads = 0;
  return () => {
    reads += 1;
    if (reads === 3) {
      throw new TypeError("clock failure");
    }
    return new Date();
  };
}

beforeAll(async () => {
  database = await createMigratedDb();
  db = createDbClient(pgliteSql(database));
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
  await finishEventSteps(database, eventId);
  const threadId = fakeId();
  await database.query(
    `UPDATE public.events SET thread_id = $2, thread_status = 'active' WHERE id = $1`,
    [eventId, threadId],
  );
  // A day after the date the run plans for, which is that of its slot's start.
  const dueDate = new Date(slotStart(new Date()) + 86_400_000)
    .toISOString()
    .slice(0, 10);
  await queryAs(
    database,
    "bot_app",
    `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, 'Book the room', $4, $5)`,
    [eventId, guild.guildId, fakeId(), dueDate, fakeId()],
  );
  mockDiscord(threadId);
});

it("records a crashed run as failed, and the next run in the slot still sends", async () => {
  const crashed = runWith(clockThatThrowsOnThirdRead());

  expect(await crashed).toMatchObject({
    status: "failed",
    error: "unexpected",
  });
  expect(posts).toEqual([]);
  const { rows } = await database.query<{
    status: string;
    error: string | null;
  }>(`SELECT status, error FROM public.job_runs WHERE job_name = 'reminders'`);
  expect(rows).toEqual([{ status: "failed", error: "unexpected" }]);

  const recovery = await runWith();

  expect(recovery).toMatchObject({ status: "succeeded" });
  expect(posts).toHaveLength(1);
});
