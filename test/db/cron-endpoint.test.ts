/**
 * The daily cron endpoint with an authorized request, from the handler down to the real
 * schema. Only Discord is a stand-in. Refusals and the deployment settings are tested in
 * src/reminders/cron-endpoint.test.ts.
 */

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as endpoint from "../../api/cron/reminders.ts";
import { configRow, GUILD_ID } from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import {
  pgliteSql,
  serverError,
  testDatabaseUrl,
} from "../support/sql-client.ts";
import { stubEnv, stubGlobal, type FetchLike } from "../support/stubs.ts";
import { handlerDb } from "./handler-db.ts";

const SECRET = "c".repeat(40);
const FORUM = fakeId();
const THREAD = fakeId();

const fetchMock = mock<FetchLike>();
/** The database the function's client runs on, and whether every statement fails. */
const current = { database: undefined as PGlite | undefined, failing: false };

void mock.module("../../src/db/neon.ts", () => ({
  neonRunner: () =>
    pgliteSql(
      () => {
        if (current.database === undefined) {
          throw new Error("the database is not set up");
        }
        return current.database;
      },
      () => (current.failing ? serverError("XX000", "row text") : undefined),
    ),
}));

function get(): Promise<Response> {
  return endpoint.GET(
    new Request("https://bot.example.test/api/cron/reminders", {
      headers: { authorization: `Bearer ${SECRET}` },
    }),
  );
}

/**
 * A new database for the next run, with a forum in this state and an event post there
 * whose task is due in two days. The event's steps are done, so only the task is due.
 */
async function databaseWithTaskDue(forum: string | null = "active") {
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const eventId = crypto.randomUUID();
  const w = await handlerDb({
    config: configRow({ timezone: "UTC" }),
    channels:
      forum === null
        ? []
        : [
            {
              guild_id: GUILD_ID,
              channel_id: FORUM,
              status: forum as "active",
            },
          ],
    events: [
      {
        id: eventId,
        guild_id: GUILD_ID,
        channel_id: FORUM,
        name: "Meeting",
        event_date: "2099-01-15",
        thread_id: THREAD,
        thread_status: "active",
        created_by: fakeId(),
      },
    ],
  });
  await w.pg.query(
    `UPDATE public.event_steps SET status = 'done', completed_at = now(), completed_by = $2
     WHERE event_id = $1`,
    [eventId, fakeId()],
  );
  await w.pg.query(
    `INSERT INTO public.tasks
       (event_id, guild_id, assignee_id, description, due_date, created_by)
     VALUES ($1, $2, $3, 'Book', $4, $3)`,
    [eventId, GUILD_ID, fakeId(), due],
  );
  current.database = w.pg;
  return w;
}

/** Discord's answer: the post, or the thread. */
const discordAnswer = (init?: RequestInit): Response =>
  Response.json(
    init?.method === "POST"
      ? { id: fakeId() }
      : { id: THREAD, type: 11, guild_id: GUILD_ID, parent_id: FORUM },
  );

/** Discord answers each request, or refuses the token. */
function discordAnswers(refused = () => false) {
  fetchMock.mockImplementation((input, init) => {
    if (!(input as string).startsWith("https://discord.com")) {
      return Promise.reject(new Error("only Discord is reached over HTTP"));
    }
    return Promise.resolve(
      refused() ? new Response("{}", { status: 401 }) : discordAnswer(init),
    );
  });
}

const discordPosts = () =>
  fetchMock.mock.calls
    .filter(
      ([url, init]) =>
        (url as string).startsWith("https://discord.com") &&
        init?.method === "POST",
    )
    .map(([url]) => url as string);

const threadPost = [
  expect.stringContaining(`/channels/${THREAD}/messages`) as string,
];

beforeEach(() => {
  current.database = undefined;
  current.failing = false;
  fetchMock.mockReset();
  stubGlobal("fetch", fetchMock);
  stubEnv("DATABASE_URL", testDatabaseUrl());
  stubEnv("CRON_SECRET", SECRET);
  stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  stubEnv("DISCORD_APP_ID", fakeId());
  stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
  spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("an authorized request", () => {
  it.each([
    ["when another run holds the lock", true],
    ["after a real run", false],
  ])("returns a fixed body %s", async (_label, locked) => {
    const w = await databaseWithTaskDue();
    if (locked) {
      await w.pg.query(
        `INSERT INTO public.job_runs (job_name) VALUES ('reminders'), ('health_check')`,
      );
    }
    discordAnswers();

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(discordPosts()).toEqual(locked ? [] : threadPost);
  });

  it("gives a fixed 500 and no detail when the database fails", async () => {
    await databaseWithTaskDue();
    current.failing = true;
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await get();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(JSON.stringify(warn.mock.calls)).toContain("unavailable:XX000");
  });

  it("does not remember a refused token from an earlier run", async () => {
    let tokenRefused = true;
    discordAnswers(() => tokenRefused);

    await databaseWithTaskDue();
    await get();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tokenRefused = false;
    fetchMock.mockClear();
    await databaseWithTaskDue();
    await get();
    expect(discordPosts()).toEqual(threadPost);
  });
});

describe("the Discord client the function builds", () => {
  it.each([
    ["has no row", null],
    ["is removed", "removed"],
  ])("sends nothing when the forum %s", async (_label, status) => {
    await databaseWithTaskDue(status);
    discordAnswers();

    await get();

    expect(discordPosts()).toEqual([]);
  });

  it("checks the forum again just before it sends", async () => {
    // The forum is removed after the run reads the task, while it looks up the thread.
    const w = await databaseWithTaskDue("active");
    fetchMock.mockImplementation(async (_input, init) => {
      if (init?.method !== "POST") {
        await w.pg.query(
          `UPDATE public.managed_channels SET status = 'removed' WHERE channel_id = $1`,
          [FORUM],
        );
      }
      return discordAnswer(init);
    });

    await get();

    expect(fetchMock).toHaveBeenCalled();
    expect(discordPosts()).toEqual([]);
  });
});
