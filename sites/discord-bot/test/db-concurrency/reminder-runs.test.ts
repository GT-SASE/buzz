import { describe, expect, it } from "bun:test";
import { claimEventReminder } from "../../src/db/event-steps.ts";
import {
  beginJobRun,
  finishJobRun,
  type JobName,
} from "../../src/db/job-runs.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { fakeId, present } from "../db/harness.ts";
import { must } from "../db/bot-writes.ts";
import { raceDatabase } from "./race.ts";

/** The wait beginJobRun and finishJobRun allow themselves for the job's lock. */
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
const slot = () => new Date(slotStart(new Date()));

/** The job's lock, as beginJobRun and finishJobRun take it, for a transaction to hold. */
const lockOf = (jobName: string): [string, unknown[]] => [
  "SELECT pg_advisory_xact_lock(hashtextextended('job_runs:' || $1::text, 0))",
  [jobName],
];

describe("two overlapping reminder runs", () => {
  it("only one of two starts gets the run", async () => {
    // A start in progress: its running row, which the other start's insert waits on.
    const second = await db.race(
      [
        [
          "INSERT INTO discord_bot.job_runs (job_name) VALUES ($1) RETURNING id",
          ["reminders"],
        ],
      ],
      (bot) =>
        beginJobRun(bot, {
          jobName: "reminders",
          staleAfterSeconds: 120,
          slotStart: slot(),
        }),
    );
    expect(second).toEqual({ ok: true, value: null });
  });

  it("a start waits for a finish in progress, then sees its success", async () => {
    const id = present(
      must(
        await beginJobRun(db.db, {
          jobName: "health_check",
          staleAfterSeconds: 120,
          slotStart: slot(),
        }),
      ),
    );

    const second = await db.race(
      [
        lockOf("health_check"),
        [
          `UPDATE discord_bot.job_runs SET status = 'succeeded', finished_at = now()
           WHERE id = $1 AND status = 'running'`,
          [id],
        ],
      ],
      (bot) =>
        beginJobRun(bot, {
          jobName: "health_check",
          staleAfterSeconds: 120,
          slotStart: slot(),
        }),
    );

    expect(second).toEqual({ ok: true, value: null });
    const statuses = await db.observer.query(
      "SELECT status FROM discord_bot.job_runs WHERE job_name = 'health_check'",
    );
    expect(statuses.rows).toEqual([{ status: "succeeded" }]);
  });

  it("only one of two claims on a task reminder gets a token", async () => {
    const guild = await insertGuild(db.connection);
    const eventId = await insertEvent(db.connection, guild);
    const taskId = await insertTask(db.connection, guild, eventId);

    const second = await db.race(
      [
        [
          `INSERT INTO discord_bot.reminder_log (task_id, kind, due_date)
           VALUES ($1, 'one_day', '2030-01-10')`,
          [taskId],
        ],
      ],
      (bot) =>
        claimReminder(bot, {
          taskId,
          kind: "one_day",
          dueDate: "2030-01-10" as DateOnly,
        }),
    );

    expect(second).toEqual({ ok: true, value: null });
    const { rows } = await db.observer.query(
      "SELECT attempts, state FROM discord_bot.reminder_log WHERE task_id = $1",
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
        [
          `INSERT INTO discord_bot.event_reminder_log (event_id, kind, reminder_date)
           VALUES ($1, 'daily_steps', $2)`,
          [eventId, today],
        ],
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
      "SELECT count(*)::int AS n FROM discord_bot.event_reminder_log WHERE event_id = $1",
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
  const newJob = () => `lock_order_${fakeId()}`;
  const longAgo = () => new Date(Date.now() - 3_600_000);
  const start = (jobName: string) =>
    beginJobRun(db.db, {
      jobName: jobName as JobName,
      staleAfterSeconds: 120,
      slotStart: longAgo(),
    });
  const finish = (id: string) =>
    finishJobRun(db.db, { id, now: new Date(), results: {}, error: null });

  async function startRun(jobName: string): Promise<string> {
    return present(must(await start(jobName)));
  }

  async function statuses(jobName: string): Promise<string[]> {
    const { rows } = await db.observer.query<{ status: string }>(
      "SELECT status FROM discord_bot.job_runs WHERE job_name = $1 ORDER BY status",
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
    const second = await db.race(
      [
        lockOf(jobName),
        [
          "INSERT INTO discord_bot.job_runs (job_name) VALUES ($1) RETURNING id",
          [jobName],
        ],
      ],
      () => start(jobName),
      "ROLLBACK",
    );
    expect(second).toEqual({ ok: true, value: expect.any(String) as string });
  });

  it("a start never slips in beside a success when fired together", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const jobName = newJob();
      const id = await startRun(jobName);
      const [finished, started] = await Promise.all([
        finish(id),
        start(jobName),
      ]);
      expect(finished.ok).toBe(true);
      expect(started).toEqual({ ok: true, value: null });
      expect(await statuses(jobName)).toEqual(["succeeded"]);
    }
  });

  it("a start gives up on a lock another session holds, and works once it is free", async () => {
    const jobName = newJob();
    await holdLockElsewhere(jobName);

    const before = Date.now();
    const refused = await start(jobName);
    const waited = Date.now() - before;

    expect(refused).toEqual({
      ok: false,
      error: { category: "unavailable", code: "55P03" },
    });
    expect(waited).toBeGreaterThanOrEqual(LOCK_WAIT_MS - 100);
    expect(waited).toBeLessThan(LONGEST_WAIT_MS);
    expect(await statuses(jobName)).toEqual([]);

    await db.t1.query("SELECT pg_advisory_unlock_all()");
    expect(await start(jobName)).toEqual({
      ok: true,
      value: expect.any(String) as string,
    });
  });

  it("a finish gives up on a lock another session holds, and leaves the run open", async () => {
    const jobName = newJob();
    const id = await startRun(jobName);
    await holdLockElsewhere(jobName);

    const refused = await finish(id);

    expect(refused).toEqual({
      ok: false,
      error: { category: "unavailable", code: "55P03" },
    });
    expect(await statuses(jobName)).toEqual(["running"]);

    await db.t1.query("SELECT pg_advisory_unlock_all()");
    expect((await finish(id)).ok).toBe(true);
    expect(await statuses(jobName)).toEqual(["succeeded"]);
  });
});
