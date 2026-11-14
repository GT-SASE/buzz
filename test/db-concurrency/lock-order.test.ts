import { describe, expect, it } from "vitest";
import { markTaskDoneAsOfficer } from "../../src/db/tasks.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId, present } from "../db/harness.ts";
import { raceDatabase, settled } from "./race.ts";

const LOCK_NOT_AVAILABLE = "55P03";
/** The wait begin_job_run and finish_job_run allow themselves, in the migrations. */
const LOCK_WAIT_MS = 3_000;
/** Longer than any wait a statement here should make. */
const LONGEST_WAIT_MS = 10_000;
const ROUNDS = 25;

/**
 * Lock order between a task update and its event's soft delete, and the job lock against
 * its other users. A wrong order shows up as a deadlock or a wait that never ends, not as
 * a wrong answer.
 */
describe("lock order", () => {
  const db = raceDatabase();

  async function eventWithTasks(
    count: number,
  ): Promise<{ guildId: string; eventId: string; taskIds: string[] }> {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      taskIds.push(await insertTask(db.connection, guild, eventId));
    }
    return { guildId: guild.guildId, eventId, taskIds };
  }

  const softDeleteSql =
    "SELECT public.soft_delete_event($1, $2) AS deleted_tasks";
  const markDoneSql = `UPDATE public.tasks SET status = 'done', completed_at = now()
                       WHERE id = $1 AND deleted_at IS NULL`;

  describe("a task update against its event's soft delete", () => {
    it("the delete waits on the task without holding the event, so both succeed", async () => {
      const { guildId, eventId, taskIds } = await eventWithTasks(1);
      const taskId = present(taskIds[0]);

      // T1 stands at the point a task update reaches first: the task's row is locked and
      // its guard has not yet asked for the event.
      await db.t1.query("BEGIN");
      await db.t1.query(
        "SELECT id FROM public.tasks WHERE id = $1 FOR NO KEY UPDATE",
        [taskId],
      );
      const deleted = settled(db.t2.query(softDeleteSql, [eventId, guildId]));
      try {
        await db.waitUntilBlocked(db.t2, db.t1);
        // With the event locked first, this statement and the delete would wait on each
        // other.
        await db.t1.query(markDoneSql, [taskId]);
      } finally {
        await db.t1.query("COMMIT");
      }

      expect(await deleted).toEqual({ rows: [{ deleted_tasks: 1 }] });
      const { rows } = await db.observer.query(
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

      const second = await db.race([softDeleteSql, [eventId, guildId]], (bot) =>
        markTaskDoneAsOfficer(bot, {
          guildId,
          taskId: present(taskIds[0]),
          now: new Date(),
        }),
      );

      expect(second).toEqual({
        ok: false,
        error: { category: "not_found", code: null },
      });
    });

    it("does not deadlock when fired together", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const { guildId, eventId, taskIds } = await eventWithTasks(5);
        const [update, deleted] = await Promise.all([
          settled(db.t1.query(markDoneSql, [taskIds[4]])),
          settled(db.t2.query(softDeleteSql, [eventId, guildId])),
        ]);
        expect(update.code).toBeUndefined();
        expect(deleted.code).toBeUndefined();
      }
    });
  });

  describe("the job lock", () => {
    // Each test names its own job, so any slot start before the test began will do.
    const beginSql =
      "SELECT public.begin_job_run($1, 120, now() - interval '1 hour') AS id";
    const finishSql = `SELECT public.finish_job_run($1, now(), '{}', NULL) AS rows`;

    const newJob = () => `lock_order_${fakeId()}`;

    async function startRun(jobName: string): Promise<string> {
      const { rows } = await db.observer.query<{ id: string }>(beginSql, [
        jobName,
      ]);
      return present(rows[0]?.id);
    }

    async function statuses(jobName: string): Promise<string[]> {
      const { rows } = await db.observer.query<{ status: string }>(
        "SELECT status FROM public.job_runs WHERE job_name = $1 ORDER BY status",
        [jobName],
      );
      return rows.map((row) => row.status);
    }

    it("the waiting start gets the run if the first one rolls back", async () => {
      const jobName = newJob();
      await db.t1.query("BEGIN");
      await db.t1.query(beginSql, [jobName]);
      const second = settled(db.t2.query(beginSql, [jobName]));
      try {
        await db.waitUntilBlocked(db.t2, db.t1);
      } finally {
        await db.t1.query("ROLLBACK");
      }
      expect(await second).toEqual({
        rows: [{ id: expect.any(String) as string }],
      });
    });

    it("a start never slips in beside a success when fired together", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const jobName = newJob();
        const id = await startRun(jobName);
        const [finished, started] = await Promise.all([
          settled(db.t1.query(finishSql, [id])),
          settled(db.t2.query(beginSql, [jobName])),
        ]);
        expect(finished.code).toBeUndefined();
        expect(started).toEqual({ rows: [{ id: null }] });
        expect(await statuses(jobName)).toEqual(["succeeded"]);
      }
    });

    /** Holds the job's lock from another session, until released. */
    async function holdLockElsewhere(jobName: string): Promise<void> {
      await db.t1.query(
        "SELECT pg_advisory_lock(hashtextextended('job_runs:' || $1::text, 0))",
        [jobName],
      );
    }

    it("a start gives up on a lock another session holds, and works once it is free", async () => {
      const jobName = newJob();
      await holdLockElsewhere(jobName);

      const before = Date.now();
      const refused = await settled(db.t2.query(beginSql, [jobName]));
      const waited = Date.now() - before;

      expect(refused.code).toBe(LOCK_NOT_AVAILABLE);
      expect(waited).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 100);
      expect(waited).toBeLessThan(LONGEST_WAIT_MS);
      expect(await statuses(jobName)).toEqual([]);

      await db.t1.query("SELECT pg_advisory_unlock_all()");
      expect(await settled(db.t2.query(beginSql, [jobName]))).toEqual({
        rows: [{ id: expect.any(String) as string }],
      });
    });

    it("a finish gives up on a lock another session holds, and leaves the run open", async () => {
      const jobName = newJob();
      const id = await startRun(jobName);
      await holdLockElsewhere(jobName);

      const refused = await settled(db.t2.query(finishSql, [id]));

      expect(refused.code).toBe(LOCK_NOT_AVAILABLE);
      expect(await statuses(jobName)).toEqual(["running"]);

      await db.t1.query("SELECT pg_advisory_unlock_all()");
      expect(
        (await settled(db.t2.query(finishSql, [id]))).code,
      ).toBeUndefined();
      expect(await statuses(jobName)).toEqual(["succeeded"]);
    });
  });
});
