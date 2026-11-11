import { randomBytes } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { PLATFORM_BOOTSTRAP, fakeId, migrationScripts } from "../db/harness.ts";

/**
 * Races between two real connections, which PGlite cannot run because it has only
 * one. Each test has T1 hold a transaction open, proves through pg_blocking_pids
 * that T2 is waiting on T1, then lets T1 finish and checks what T2 got.
 *
 * Needs CONCURRENCY_DATABASE_URL, pointing at a Postgres 17 superuser connection.
 * A missing or wrong server fails the run: these tests must never skip.
 */

const STALE_VERSION = "CF409";
const PARENT_UNAVAILABLE = "CF410";
const EVENT_TASK_LIMIT = "CF429";
const ACTOR_TASK_LIMIT = "CF430";
const EXPECTED_MAJOR_VERSION = "17";
const BLOCK_TIMEOUT_MS = 10_000;

interface Outcome {
  rows?: Record<string, unknown>[];
  code?: string | undefined;
}

function urlForDatabase(adminUrl: string, name: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("concurrent writes", () => {
  const databaseName = `concurrency_${randomBytes(6).toString("hex")}`;
  let cluster: pg.Client;
  let observer: pg.Client;
  let t1: pg.Client;
  let t2: pg.Client;

  // Filled in as setup goes, so that a setup failure still cleans up what it made.
  const cleanups: (() => Promise<unknown>)[] = [];
  let databaseUrl: string;

  beforeAll(async () => {
    const adminUrl = process.env.CONCURRENCY_DATABASE_URL;
    if (!adminUrl) {
      throw new Error(
        "CONCURRENCY_DATABASE_URL is not set, so the concurrency tests cannot run",
      );
    }

    cluster = new pg.Client({ connectionString: adminUrl });
    await cluster.connect();
    cleanups.unshift(() => cluster.end());
    const version = await cluster.query<{ server_version_num: string }>(
      "SHOW server_version_num",
    );
    expect(version.rows[0]?.server_version_num.slice(0, 2)).toBe(
      EXPECTED_MAJOR_VERSION,
    );
    await cluster.query(`CREATE DATABASE ${databaseName}`);
    cleanups.unshift(() =>
      cluster.query(`DROP DATABASE IF EXISTS ${databaseName}`),
    );

    databaseUrl = urlForDatabase(adminUrl, databaseName);
    observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    cleanups.unshift(() => observer.end());
    await observer.query(PLATFORM_BOOTSTRAP);
    for (const script of migrationScripts()) {
      await observer.query(script);
    }
  });

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    t1 = new pg.Client({ connectionString: databaseUrl });
    t2 = new pg.Client({ connectionString: databaseUrl });
    await t1.connect();
    await t2.connect();
    await t1.query("SET ROLE service_role");
    await t2.query("SET ROLE service_role");
  });

  afterEach(async () => {
    await t1.end();
    await t2.end();
  });

  async function pidOf(client: pg.Client): Promise<number> {
    const { rows } = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    return (rows[0] as { pid: number }).pid;
  }

  /** Waits until T2 is blocked by T1, and fails if that never happens. */
  async function waitUntilBlocked(t1Pid: number, t2Pid: number): Promise<void> {
    const deadline = Date.now() + BLOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { rows } = await observer.query<{ blockers: number[] }>(
        "SELECT pg_blocking_pids($1) AS blockers",
        [t2Pid],
      );
      if (rows[0]?.blockers.includes(t1Pid)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("T2 never blocked on T1");
  }

  /**
   * T1 runs its statement in an open transaction, T2 runs its statement and must
   * block, then T1 finishes. Returns what T2 got.
   */
  async function race(
    first: [string, unknown[]],
    second: [string, unknown[]],
    finish: "COMMIT" | "ROLLBACK" = "COMMIT",
  ): Promise<Outcome> {
    const t1Pid = await pidOf(t1);
    const t2Pid = await pidOf(t2);
    await t1.query("BEGIN");
    await t1.query(first[0], first[1]);

    const outcome: Promise<Outcome> = t2.query(second[0], second[1]).then(
      (result) => ({ rows: result.rows as Record<string, unknown>[] }),
      (error: unknown) => ({ code: (error as { code?: string }).code }),
    );

    try {
      await waitUntilBlocked(t1Pid, t2Pid);
    } finally {
      await t1.query(finish);
    }
    return outcome;
  }

  async function setUpGuild(): Promise<{ guildId: string; channelId: string }> {
    const guildId = fakeId();
    const channelId = fakeId();
    await observer.query(
      "SELECT public.apply_role_bindings($1, 0, $2, $3, $4)",
      [guildId, fakeId(), fakeId(), fakeId()],
    );
    await observer.query(
      "SELECT public.apply_config_change($1, 1, $2, NULL, ARRAY[$3]::text[])",
      [guildId, fakeId(), channelId],
    );
    return { guildId, channelId };
  }

  const insertEventSql = `INSERT INTO public.events (guild_id, channel_id, name, event_date, created_by)
                          VALUES ($1, $2, 'Social', '2030-02-01', $3) RETURNING id`;
  const insertTaskSql = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                         VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $3) RETURNING id`;

  async function insertEvent(
    guildId: string,
    channelId: string,
  ): Promise<string> {
    const { rows } = await observer.query<{ id: string }>(insertEventSql, [
      guildId,
      channelId,
      fakeId(),
    ]);
    return (rows[0] as { id: string }).id;
  }

  async function auditCount(guildId: string): Promise<number> {
    const { rows } = await observer.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.config_audit WHERE guild_id = $1",
      [guildId],
    );
    return (rows[0] as { n: number }).n;
  }

  describe("config version", () => {
    const changeSql =
      "SELECT public.apply_config_change($1, $2, $3, $4) AS version";

    it("settings: the panel that loses the race gets CF409", async () => {
      const { guildId } = await setUpGuild();
      const outcome = await race(
        [changeSql, [guildId, 2, fakeId(), false]],
        [changeSql, [guildId, 2, fakeId(), true]],
      );

      expect(outcome.code).toBe(STALE_VERSION);
      const { rows } = await observer.query(
        "SELECT version, reminders_enabled FROM public.guild_config WHERE guild_id = $1",
        [guildId],
      );
      expect(rows).toEqual([{ version: 3, reminders_enabled: false }]);
      expect(await auditCount(guildId)).toBe(3);
    });

    it("role bindings: the panel that loses the race gets CF409", async () => {
      const { guildId } = await setUpGuild();
      const sql =
        "SELECT public.apply_role_bindings($1, $2, $3, $4, $5) AS version";
      const outcome = await race(
        [sql, [guildId, 2, fakeId(), fakeId(), fakeId()]],
        [sql, [guildId, 2, fakeId(), fakeId(), fakeId()]],
      );

      expect(outcome.code).toBe(STALE_VERSION);
      expect(await auditCount(guildId)).toBe(3);
    });

    it("settings: the waiting panel succeeds if the first one rolls back", async () => {
      const { guildId } = await setUpGuild();
      const outcome = await race(
        [changeSql, [guildId, 2, fakeId(), false]],
        [changeSql, [guildId, 2, fakeId(), true]],
        "ROLLBACK",
      );
      expect(outcome.rows).toEqual([{ version: 3 }]);
    });
  });

  describe("first setup", () => {
    const setupSql =
      "SELECT public.apply_role_bindings($1, 0, $2, $3, $4) AS version";

    it("the setup that loses the race gets CF409, with one audit row", async () => {
      const guildId = fakeId();
      const outcome = await race(
        [setupSql, [guildId, fakeId(), fakeId(), fakeId()]],
        [setupSql, [guildId, fakeId(), fakeId(), fakeId()]],
      );

      expect(outcome.code).toBe(STALE_VERSION);
      expect(await auditCount(guildId)).toBe(1);
    });

    it("the waiting setup succeeds if the first one rolls back", async () => {
      const guildId = fakeId();
      const outcome = await race(
        [setupSql, [guildId, fakeId(), fakeId(), fakeId()]],
        [setupSql, [guildId, fakeId(), fakeId(), fakeId()]],
        "ROLLBACK",
      );
      expect(outcome.rows).toEqual([{ version: 1 }]);
    });
  });

  describe("reminder claims", () => {
    const claimSql = `SELECT public.claim_reminder($1, 'one_day', '2030-01-10') AS token`;

    it("only one of two concurrent claims gets a token", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      const task = await observer.query<{ id: string }>(insertTaskSql, [
        eventId,
        guildId,
        fakeId(),
      ]);
      const taskId = task.rows[0]?.id;

      const outcome = await race([claimSql, [taskId]], [claimSql, [taskId]]);

      expect(outcome.rows).toEqual([{ token: null }]);
      const { rows } = await observer.query(
        "SELECT attempts, state FROM public.reminder_log WHERE task_id = $1",
        [taskId],
      );
      expect(rows).toEqual([{ attempts: 1, state: "claimed" }]);
    });
  });

  describe("job run lock", () => {
    const beginSql = "SELECT public.begin_job_run($1, 120) AS id";

    it("only one of two concurrent starts gets a run", async () => {
      const jobName = `race_${fakeId()}`;
      const outcome = await race([beginSql, [jobName]], [beginSql, [jobName]]);
      expect(outcome.rows).toEqual([{ id: null }]);
    });

    it("the waiting start wins if the first one rolls back", async () => {
      const jobName = `race_${fakeId()}`;
      const outcome = await race(
        [beginSql, [jobName]],
        [beginSql, [jobName]],
        "ROLLBACK",
      );
      expect(outcome.rows).toEqual([{ id: expect.any(String) as string }]);
    });
  });

  describe("interaction claims", () => {
    const claimSql = "SELECT public.claim_interaction($1) AS claimed";

    it("only one of two concurrent claims wins", async () => {
      const interactionId = fakeId();
      const outcome = await race(
        [claimSql, [interactionId]],
        [claimSql, [interactionId]],
      );
      expect(outcome.rows).toEqual([{ claimed: false }]);
    });

    it("the waiting claim wins if the first one rolls back", async () => {
      const interactionId = fakeId();
      const outcome = await race(
        [claimSql, [interactionId]],
        [claimSql, [interactionId]],
        "ROLLBACK",
      );
      expect(outcome.rows).toEqual([{ claimed: true }]);
    });
  });

  describe("task commands", () => {
    const markOwnDoneSql = `UPDATE public.tasks SET status = 'done', completed_at = now()
                            WHERE id = $1 AND guild_id = $2 AND assignee_id = $3
                              AND status = 'open' AND deleted_at IS NULL
                            RETURNING id`;

    it("a mark done waiting on a reassign finds the task no longer its own", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      const assignee = fakeId();
      const { rows } = await observer.query<{ id: string }>(insertTaskSql, [
        eventId,
        guildId,
        assignee,
      ]);
      const taskId = rows[0]?.id;

      const outcome = await race(
        [
          "UPDATE public.tasks SET assignee_id = $1 WHERE id = $2",
          [fakeId(), taskId],
        ],
        [markOwnDoneSql, [taskId, guildId, assignee]],
      );

      expect(outcome.rows).toEqual([]);
      const state = await observer.query(
        "SELECT status FROM public.tasks WHERE id = $1",
        [taskId],
      );
      expect(state.rows).toEqual([{ status: "open" }]);
    });

    it("a task waiting on the event's last free place is refused", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      for (let index = 0; index < 99; index += 1) {
        await observer.query(insertTaskSql, [eventId, guildId, fakeId()]);
      }

      const outcome = await race(
        [insertTaskSql, [eventId, guildId, fakeId()]],
        [insertTaskSql, [eventId, guildId, fakeId()]],
      );

      expect(outcome.code).toBe(EVENT_TASK_LIMIT);
    });

    it("a reassignment waiting on an officer's last action of the day is refused", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      const officer = fakeId();
      const insertBy = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                        VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $4) RETURNING id`;
      const created = await observer.query<{ id: string }>(insertBy, [
        eventId,
        guildId,
        fakeId(),
        officer,
      ]);
      for (let index = 0; index < 48; index += 1) {
        await observer.query(insertBy, [eventId, guildId, fakeId(), officer]);
      }
      const reassign = `INSERT INTO public.task_reassignments (guild_id, actor_id, task_id) VALUES ($1, $2, $3)`;
      const params = [guildId, officer, created.rows[0]?.id];

      const outcome = await race([reassign, params], [reassign, params]);

      expect(outcome.code).toBe(ACTOR_TASK_LIMIT);
    });

    it("a task change waiting on a close is refused, and a close waits for one", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      const { rows } = await observer.query<{ id: string }>(insertTaskSql, [
        eventId,
        guildId,
        fakeId(),
      ]);
      const change =
        "UPDATE public.tasks SET description = 'New' WHERE id = $1";
      const close =
        "UPDATE public.events SET status = 'closed' WHERE id = $1 RETURNING id";

      const closedFirst = await race(
        [close, [eventId]],
        [change, [rows[0]?.id]],
      );
      expect(closedFirst.code).toBe(PARENT_UNAVAILABLE);

      const secondEvent = await insertEvent(guildId, channelId);
      const second = await observer.query<{ id: string }>(insertTaskSql, [
        secondEvent,
        guildId,
        fakeId(),
      ]);
      const changedFirst = await race(
        [change, [second.rows[0]?.id]],
        [close, [secondEvent]],
      );
      expect(changedFirst.rows).toEqual([{ id: secondEvent }]);
    });

    it("refuses a quota write at a higher isolation level, which could pass the count", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);

      await t1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        t1.query(insertTaskSql, [eventId, guildId, fakeId()]),
      ).rejects.toMatchObject({ code: "0A000" });
      await t1.query("ROLLBACK");

      const { rows } = await observer.query<{ id: string }>(insertTaskSql, [
        eventId,
        guildId,
        fakeId(),
      ]);
      await t1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await expect(
        t1.query(
          `INSERT INTO public.task_reassignments (guild_id, actor_id, task_id) VALUES ($1, $2, $3)`,
          [guildId, fakeId(), rows[0]?.id],
        ),
      ).rejects.toMatchObject({ code: "0A000" });
      await t1.query("ROLLBACK");
    });

    it("a task waiting on an officer's last task of the day is refused", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);
      const otherEvent = await insertEvent(guildId, channelId);
      const officer = fakeId();
      const insertBy = `INSERT INTO public.tasks (event_id, guild_id, assignee_id, description, due_date, created_by)
                        VALUES ($1, $2, $3, 'Book the room', '2030-01-10', $4) RETURNING id`;
      for (let index = 0; index < 49; index += 1) {
        await observer.query(insertBy, [eventId, guildId, fakeId(), officer]);
      }

      const outcome = await race(
        [insertBy, [eventId, guildId, fakeId(), officer]],
        [insertBy, [otherEvent, guildId, fakeId(), officer]],
      );

      expect(outcome.code).toBe(ACTOR_TASK_LIMIT);
    });
  });

  describe("open parent guard", () => {
    const softDeleteSql = "SELECT public.soft_delete_event($1, $2) AS deleted";

    it("a soft delete waits for a task being inserted, then deletes it too", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);

      const outcome = await race(
        [insertTaskSql, [eventId, guildId, fakeId()]],
        [softDeleteSql, [eventId, guildId]],
      );

      expect(outcome.rows).toEqual([{ deleted: 1 }]);
      const { rows } = await observer.query(
        "SELECT count(*)::int AS n FROM public.tasks WHERE event_id = $1 AND deleted_at IS NULL",
        [eventId],
      );
      expect(rows).toEqual([{ n: 0 }]);
    });

    it("a task insert waits for a soft delete, then is refused", async () => {
      const { guildId, channelId } = await setUpGuild();
      const eventId = await insertEvent(guildId, channelId);

      const outcome = await race(
        [softDeleteSql, [eventId, guildId]],
        [insertTaskSql, [eventId, guildId, fakeId()]],
      );

      expect(outcome.code).toBe(PARENT_UNAVAILABLE);
    });

    it("an event insert waits for its channel being removed, then is refused", async () => {
      const { guildId, channelId } = await setUpGuild();

      const outcome = await race(
        [
          "SELECT public.apply_config_change($1, 2, $2, NULL, NULL, ARRAY[$3]::text[])",
          [guildId, fakeId(), channelId],
        ],
        [insertEventSql, [guildId, channelId, fakeId()]],
      );

      expect(outcome.code).toBe(PARENT_UNAVAILABLE);
    });
  });
});
