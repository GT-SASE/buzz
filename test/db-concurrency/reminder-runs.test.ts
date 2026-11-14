import { describe, expect, it } from "vitest";
import { claimEventReminder } from "../../src/db/event-steps.ts";
import { beginJobRun } from "../../src/db/job-runs.ts";
import { claimReminder } from "../../src/db/reminders.ts";
import { todayInZone, type DateOnly } from "../../src/lib/dates.ts";
import { slotStart } from "../../src/reminders/plan.ts";
import { insertEvent, insertGuild, insertTask } from "../db/fixtures.ts";
import { raceDatabase } from "./race.ts";

/**
 * The morning cron and the recovery cron, or a retried invocation, running at once. The
 * job lock keeps the second run out, and each reminder's claim stops a double send if
 * both get past it, as they can once a run's lock has gone stale. Each test names its
 * own job, since a run left behind by one would hold off the next.
 */
describe("two overlapping reminder runs", () => {
  const db = raceDatabase();
  const beginSql = "SELECT public.begin_job_run($1, 120, $2) AS id";
  const slot = () => new Date(slotStart(new Date()));

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

    const second = await db.race(
      ["SELECT public.finish_job_run($1, now(), '{}', NULL)", [rows[0]?.id]],
      (bot) =>
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
