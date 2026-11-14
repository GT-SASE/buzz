import { describe, expect, it } from "bun:test";
import { claimEventReminder } from "../../src/db/event-steps.ts";
import { beginJobRun } from "../../src/db/job-runs.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import { slotStart } from "../../src/reminders/plan.ts";
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
 * The morning cron and the recovery cron, or a retried invocation, running at once. The
 * job lock keeps the second run out, and each reminder's claim stops a double send if
 * both get past it, as they can once a run's lock has gone stale.
 */
const db = raceDatabase();
const beginSql = "SELECT public.begin_job_run($1, 120, $2) AS id";
const finishSql = `SELECT public.finish_job_run($1, now(), '{}', NULL) AS rows`;
const slot = () => new Date(slotStart(new Date()));

describe("two overlapping reminder runs", () => {
  it("only one of two starts gets the run", async () => {
    const second = await db.race([beginSql, ["reminders", slot()]], (bot) =>
      beginJobRun(bot, {
        jobName: "reminders",
        staleAfterSeconds: 120,
        slotStart: slot(),
      }),
    );
    expect(second).toEqual({ ok: true, value: null });
  });

  it("a start waits for a finish in progress, then sees its success", async () => {
    const { rows } = await db.observer.query<{ id: string }>(beginSql, [
      "health_check",
      slot(),
    ]);

    const second = await db.race([finishSql, [rows[0]?.id]], (bot) =>
      beginJobRun(bot, {
        jobName: "health_check",
        staleAfterSeconds: 120,
        slotStart: slot(),
      }),
    );

    expect(second).toEqual({ ok: true, value: null });
    const statuses = await db.observer.query(
      "SELECT status FROM public.job_runs WHERE job_name = 'health_check'",
    );
    expect(statuses.rows).toEqual([{ status: "succeeded" }]);
  });

  it("only one of two claims on a task reminder gets a token", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);

    const second = await db.race(
      ["SELECT public.claim_reminder($1, 'one_day', '2030-01-10')", [taskId]],
      (bot) =>
        claimReminder(bot, {
          taskId,
          kind: "one_day",
          dueDate: "2030-01-10" as DateOnly,
        }),
    );

    expect(second).toEqual({ ok: true, value: null });
    const { rows } = await db.observer.query(
      "SELECT attempts, state FROM public.reminder_log WHERE task_id = $1",
      [taskId],
    );
    expect(rows).toEqual([{ attempts: 1, state: "claimed" }]);
  });

  it("only one of two claims on an event's step reminder gets a token", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    // A step reminder can be claimed only for today or yesterday in the guild's zone.
    const today = todayInZone(new Date(), "America/New_York");

    const second = await db.race(
      [
        "SELECT public.claim_event_reminder($1, 'daily_steps', $2)",
        [eventId, today],
      ],
      (bot) =>
        claimEventReminder(bot, {
          eventId,
          kind: "daily_steps",
          reminderDate: today,
        }),
    );

    expect(second).toEqual({ ok: true, value: null });
    const { rows } = await db.observer.query(
      "SELECT count(*)::int AS n FROM public.event_reminder_log WHERE event_id = $1",
      [eventId],
    );
    expect(rows).toEqual([{ n: 1 }]);
  });
});

/**
 * The job lock against its other users. A wrong lock order shows up as a deadlock or a
 * wait that never ends, not as a wrong answer. Each test names its own job, so any slot
 * start before the test began will do.
 */
describe("the job lock", () => {
  const beginOwnSql =
    "SELECT public.begin_job_run($1, 120, now() - interval '1 hour') AS id";
  const newJob = () => `lock_order_${fakeId()}`;

  async function startRun(jobName: string): Promise<string> {
    const { rows } = await db.observer.query<{ id: string }>(beginOwnSql, [
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

  /** Holds the job's lock from another session, until released. */
  async function holdLockElsewhere(jobName: string): Promise<void> {
    await db.t1.query(
      "SELECT pg_advisory_lock(hashtextextended('job_runs:' || $1::text, 0))",
      [jobName],
    );
  }

  it("the waiting start gets the run if the first one rolls back", async () => {
    const jobName = newJob();
    await db.t1.query("BEGIN");
    await db.t1.query(beginOwnSql, [jobName]);
    const second = settled(db.t2.query(beginOwnSql, [jobName]));
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
        settled(db.t2.query(beginOwnSql, [jobName])),
      ]);
      expect(finished.code).toBeUndefined();
      expect(started).toEqual({ rows: [{ id: null }] });
      expect(await statuses(jobName)).toEqual(["succeeded"]);
    }
  });

  it("a start gives up on a lock another session holds, and works once it is free", async () => {
    const jobName = newJob();
    await holdLockElsewhere(jobName);

    const before = Date.now();
    const refused = await settled(db.t2.query(beginOwnSql, [jobName]));
    const waited = Date.now() - before;

    expect(refused.code).toBe(LOCK_NOT_AVAILABLE);
    expect(waited).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 100);
    expect(waited).toBeLessThan(LONGEST_WAIT_MS);
    expect(await statuses(jobName)).toEqual([]);

    await db.t1.query("SELECT pg_advisory_unlock_all()");
    expect(await settled(db.t2.query(beginOwnSql, [jobName]))).toEqual({
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
    expect((await settled(db.t2.query(finishSql, [id]))).code).toBeUndefined();
    expect(await statuses(jobName)).toEqual(["succeeded"]);
  });
});
