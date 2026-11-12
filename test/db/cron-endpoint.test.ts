/**
 * The daily cron endpoint with an authorized request, from the handler down to the real
 * schema. Only Discord is a stand-in. Refusals and the deployment settings are tested in
 * src/reminders/cron-endpoint.test.ts.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as endpoint from "../../api/cron/reminders.ts";
import { DISCORD_OPERATION_MS } from "../../src/reminders/run.ts";
import { configRow, GUILD_ID } from "../support/interactions.ts";
import { fakeId } from "../support/ids.ts";
import { testDatabaseUrl } from "../support/sql-client.ts";
import { handlerDb } from "./handler-db.ts";

const SECRET = "c".repeat(40);
const AUTHORIZED = { authorization: `Bearer ${SECRET}` };
const FORUM = fakeId();
const THREAD = fakeId();

const fetchMock = vi.fn<typeof fetch>();

const clients = vi.hoisted(() => ({
  options: [] as unknown[],
  made: [] as unknown[],
}));

vi.mock("../../src/discord/client.ts", async (original) => {
  const actual = await original<typeof import("../../src/discord/client.ts")>();
  return {
    ...actual,
    createDiscordClient: (
      options: Parameters<typeof actual.createDiscordClient>[0],
    ) => {
      clients.options.push(options);
      const client = actual.createDiscordClient(options);
      clients.made.push(client);
      return client;
    },
  };
});

/** The database the function's client runs on, and whether every statement fails. */
const current = vi.hoisted(() => ({
  database: undefined as PGlite | undefined,
  failing: false,
}));

vi.mock("../../src/db/neon.ts", async () => {
  const { pgliteSql, serverError: failure } =
    await import("../support/sql-client.ts");
  return {
    neonRunner: () =>
      pgliteSql(
        () => {
          if (current.database === undefined) {
            throw new Error("the database is not set up");
          }
          return current.database;
        },
        () => (current.failing ? failure("XX000", "row text") : undefined),
      ),
  };
});

function get(): Promise<Response> {
  return endpoint.GET(
    new Request("https://bot.example.test/api/cron/reminders", {
      headers: AUTHORIZED,
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

/** Discord answers each request: the thread and the post, or a refused token. */
function discordAnswers(refused = () => false) {
  fetchMock.mockImplementation((input, init) => {
    const url = input as string;
    if (!url.startsWith("https://discord.com")) {
      return Promise.reject(new Error("only Discord is reached over HTTP"));
    }
    if (refused()) {
      return Promise.resolve(new Response("{}", { status: 401 }));
    }
    return Promise.resolve(
      Response.json(
        init?.method === "POST"
          ? { id: fakeId() }
          : { id: THREAD, type: 11, guild_id: GUILD_ID, parent_id: FORUM },
      ),
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

beforeEach(() => {
  clients.options = [];
  clients.made = [];
  current.database = undefined;
  current.failing = false;
  vi.stubEnv("DATABASE_URL", testDatabaseUrl());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("DISCORD_BOT_TOKEN", "unit-test-token");
  vi.stubEnv("DISCORD_APP_ID", fakeId());
  vi.stubEnv("ALLOWED_GUILD_IDS", GUILD_ID);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("an authorized request", () => {
  it("returns a fixed body when another run holds the lock", async () => {
    const w = await databaseWithTaskDue();
    await w.pg.query(
      `INSERT INTO public.job_runs (job_name) VALUES ('reminders'), ('health_check')`,
    );
    discordAnswers();

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the same fixed body after a real run", async () => {
    await databaseWithTaskDue();
    discordAnswers();

    const response = await get();

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("gives a fixed 500 and no detail when the database fails", async () => {
    await databaseWithTaskDue();
    current.failing = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await get();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(JSON.stringify(warn.mock.calls)).toContain("unavailable:XX000");
  });

  it("gives a fixed 500 and names only the setting when config is missing", async () => {
    await databaseWithTaskDue();
    vi.stubEnv("ALLOWED_GUILD_IDS", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const response = await get();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("internal error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("ALLOWED_GUILD_IDS");
  });

  it("builds a new Discord client on each run, so a refused token is not remembered", async () => {
    // The first run's token is refused. The second must ask Discord afresh, and send.
    let tokenRefused = true;
    discordAnswers(() => tokenRefused);
    const discordCalls = () =>
      fetchMock.mock.calls.filter(([url]) =>
        (url as string).startsWith("https://discord.com"),
      );

    await databaseWithTaskDue();
    await get();
    expect(discordCalls()).toHaveLength(1);

    tokenRefused = false;
    fetchMock.mockClear();
    await databaseWithTaskDue();
    await get();
    expect(discordPosts()).toEqual([
      expect.stringContaining(`/channels/${THREAD}/messages`),
    ]);

    expect(clients.made).toHaveLength(2);
    expect(clients.made[1]).not.toBe(clients.made[0]);
  });
});

describe("the Discord client the function builds", () => {
  it("sends to a thread in an active forum", async () => {
    await databaseWithTaskDue("active");
    discordAnswers();

    await get();

    expect(discordPosts()).toEqual([
      expect.stringContaining(`/channels/${THREAD}/messages`),
    ]);
  });

  it.each([
    ["has no row", null],
    ["is removed", "removed"],
    ["is unavailable", "unavailable"],
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
      return Response.json(
        init?.method === "POST"
          ? { id: fakeId() }
          : { id: THREAD, type: 11, guild_id: GUILD_ID, parent_id: FORUM },
      );
    });

    await get();

    expect(fetchMock).toHaveBeenCalled();
    expect(discordPosts()).toEqual([]);
  });

  it("has the run's time limit for each operation", async () => {
    await databaseWithTaskDue("active");
    discordAnswers();

    await get();

    expect(clients.options).toEqual([
      expect.objectContaining({
        budget: { operationMs: DISCORD_OPERATION_MS },
      }),
    ]);
  });
});
