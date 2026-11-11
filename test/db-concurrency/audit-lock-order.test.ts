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
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import {
  BACKUP_ROLE,
  PLATFORM_BOOTSTRAP,
  fakeId,
  migrationScripts,
  pgConnection,
  present,
  type Connection,
} from "../db/harness.ts";

/**
 * Lock order between a task update and an event's soft delete, and the job lock's users.
 * Needs CONCURRENCY_DATABASE_URL, as test/db-concurrency/concurrency.test.ts does, and
 * fails without it.
 */

const LOCK_NOT_AVAILABLE = "55P03";
/** The wait begin_job_run and finish_job_run allow themselves, in the migration. */
const LOCK_WAIT_MS = 3_000;
const BLOCK_TIMEOUT_MS = 10_000;
const ROUNDS = 25;

interface Outcome {
  rows?: Record<string, unknown>[];
  code?: string | undefined;
}

function settled(query: Promise<pg.QueryResult>): Promise<Outcome> {
  return query.then(
    (result) => ({ rows: result.rows as Record<string, unknown>[] }),
    (error: unknown) => ({ code: (error as { code?: string }).code }),
  );
}

describe("lock order", () => {
  const databaseName = `lock_order_${randomBytes(6).toString("hex")}`;
  let cluster: pg.Client;
  let observer: pg.Client;
  let connection: Connection;
  let t1: pg.Client;
  let t2: pg.Client;
  let t1Pid: number;
  let t2Pid: number;
  let databaseUrl: string;

  const cleanups: (() => Promise<unknown>)[] = [];

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
    await cluster.query(`CREATE DATABASE ${databaseName}`);
    cleanups.unshift(() =>
      cluster.query(`DROP DATABASE IF EXISTS ${databaseName}`),
    );

    const url = new URL(adminUrl);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    observer = new pg.Client({ connectionString: databaseUrl });
    await observer.connect();
    cleanups.unshift(() => observer.end());
    connection = pgConnection(observer);
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
    // Read here, while both are idle. A query on a client that is already blocked would
    // queue behind the blocked statement and not return until the wait was over.
    t1Pid = await pidOf(t1);
    t2Pid = await pidOf(t2);
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

  /** Waits until T2 is waiting on T1, and fails if that never happens. */
  async function waitUntilBlocked(): Promise<void> {
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
    throw new Error("the second connection never blocked on the first");
  }

  async function eventWithTasks(
    count: number,
  ): Promise<{ guildId: string; eventId: string; taskIds: string[] }> {
    const guild = await insertGuild(connection);
    const eventId = await insertEvent(connection, guild);
    const taskIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      taskIds.push(await insertTask(connection, guild, eventId));
    }
    return { guildId: guild.guildId, eventId, taskIds };
  }

  const softDeleteSql =
    "SELECT public.soft_delete_event($1, $2) AS deleted_tasks";
  const markDoneSql = `UPDATE public.tasks SET status = 'done', completed_at = now()
                       WHERE id = $1 AND deleted_at IS NULL`;

  describe("a task update against an event's soft delete", () => {
    it("the delete waits on the task without holding the event, so both succeed", async () => {
      const { guildId, eventId, taskIds } = await eventWithTasks(1);
      const taskId = present(taskIds[0]);

      // T1 stands at the point a task update reaches first: the task's row is locked and
      // its guard has not yet asked for the event.
      await t1.query("BEGIN");
      await t1.query(
        "SELECT id FROM public.tasks WHERE id = $1 FOR NO KEY UPDATE",
        [taskId],
      );
      const deleted = settled(t2.query(softDeleteSql, [eventId, guildId]));
      await waitUntilBlocked();

      // With the event locked first, this statement and the delete would wait on each other.
      await t1.query(markDoneSql, [taskId]);
      await t1.query("COMMIT");

      expect(await deleted).toEqual({ rows: [{ deleted_tasks: 1 }] });
      const { rows } = await observer.query(
        `SELECT t.status, t.deleted_at IS NOT NULL AS task_gone, e.deleted_at IS NOT NULL AS event_gone
         FROM public.tasks t JOIN public.events e ON e.id = t.event_id
         WHERE t.id = $1`,
        [taskId],
      );
      expect(rows).toEqual([
        { status: "done", task_gone: true, event_gone: true },
      ]);
    });

    it("an update that waits on the delete finds the task gone", async () => {
      const { guildId, eventId, taskIds } = await eventWithTasks(1);
      await t1.query("BEGIN");
      await t1.query(softDeleteSql, [eventId, guildId]);
      const update = t2.query(markDoneSql, [taskIds[0]]);
      await waitUntilBlocked();
      await t1.query("COMMIT");
      expect((await update).rowCount).toBe(0);
    });

    it("does not deadlock when fired together", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { guildId, eventId, taskIds } = await eventWithTasks(5);
        const [update, deleted] = await Promise.all([
          settled(t1.query(markDoneSql, [taskIds[4]])),
          settled(t2.query(softDeleteSql, [eventId, guildId])),
        ]);
        expect(update.code).toBeUndefined();
        expect(deleted.code).toBeUndefined();
      }
    });
  });

  describe("the job lock", () => {
    const beginSql = "SELECT public.begin_job_run($1, 120) AS id";
    const finishSql = `SELECT public.finish_job_run($1, now(), '{}', NULL) AS rows`;

    const newJob = () => `lock_order_${fakeId()}`;

    async function startRun(jobName: string): Promise<string> {
      const { rows } = await observer.query<{ id: string }>(beginSql, [
        jobName,
      ]);
      return (rows[0] as { id: string }).id;
    }

    async function statuses(jobName: string): Promise<string[]> {
      const { rows } = await observer.query<{ status: string }>(
        "SELECT status FROM public.job_runs WHERE job_name = $1 ORDER BY status",
        [jobName],
      );
      return rows.map((row) => row.status);
    }

    it("a start waits for a finish in progress, then sees its success", async () => {
      const jobName = newJob();
      const id = await startRun(jobName);
      await t1.query("BEGIN");
      await t1.query(finishSql, [id]);
      const started = settled(t2.query(beginSql, [jobName]));
      await waitUntilBlocked();
      await t1.query("COMMIT");
      expect(await started).toEqual({ rows: [{ id: null }] });
      expect(await statuses(jobName)).toEqual(["succeeded"]);
    });

    it("a start never slips in beside a success when fired together", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const jobName = newJob();
        const id = await startRun(jobName);
        const [finished, started] = await Promise.all([
          settled(t1.query(finishSql, [id])),
          settled(t2.query(beginSql, [jobName])),
        ]);
        expect(finished.code).toBeUndefined();
        expect(started).toEqual({ rows: [{ id: null }] });
        expect(await statuses(jobName)).toEqual(["succeeded"]);
      }
    });

    /** Holds the job's lock the way a session of the backup role could, until released. */
    async function holdLockAsBackupRole(jobName: string): Promise<void> {
      await t1.query(`SET ROLE ${BACKUP_ROLE}`);
      await t1.query(
        "SELECT pg_advisory_lock(hashtextextended('job_runs:' || $1::text, 0))",
        [jobName],
      );
    }

    it("a start gives up on a lock the backup role holds, and works once it is free", async () => {
      const jobName = newJob();
      await holdLockAsBackupRole(jobName);

      const before = Date.now();
      const refused = await settled(t2.query(beginSql, [jobName]));
      const waited = Date.now() - before;

      expect(refused.code).toBe(LOCK_NOT_AVAILABLE);
      expect(waited).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 100);
      expect(waited).toBeLessThan(BLOCK_TIMEOUT_MS);
      expect(await statuses(jobName)).toEqual([]);

      await t1.query("SELECT pg_advisory_unlock_all()");
      expect(await settled(t2.query(beginSql, [jobName]))).toEqual({
        rows: [{ id: expect.any(String) as string }],
      });
    });

    it("a finish gives up on a lock the backup role holds, and leaves the run open", async () => {
      const jobName = newJob();
      const id = await startRun(jobName);
      await holdLockAsBackupRole(jobName);

      const refused = await settled(t2.query(finishSql, [id]));

      expect(refused.code).toBe(LOCK_NOT_AVAILABLE);
      expect(await statuses(jobName)).toEqual(["running"]);

      await t1.query("SELECT pg_advisory_unlock_all()");
      expect((await settled(t2.query(finishSql, [id]))).code).toBeUndefined();
      expect(await statuses(jobName)).toEqual(["succeeded"]);
    });
  });
});
