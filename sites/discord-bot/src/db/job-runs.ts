import { and, eq, gt, gte, lt, lte, or, sql as dsql } from "drizzle-orm";
import type { BotTx, DbClient } from "./client.ts";
import { changedRow, firstRow, query, sql, transact } from "./internal.ts";
import { isoTimestamp } from "./parsers.ts";
import { jobRuns } from "./schema.ts";
import {
  errorSummary,
  refused,
  type DbError,
  type DbResult,
} from "./errors.ts";
import type { JobRun } from "./types.ts";
import { isUuid } from "./validate.ts";

export type JobName = "reminders" | "health_check";

/**
 * Counts, plus lists of event IDs under names ending in `_event_ids`, so no message text or
 * user input can end up in a run's results.
 */
export type JobResults = Readonly<Record<string, number | string[]>>;

const RESULT_KEY = /^[a-z_]{1,64}$/;
const MAX_RESULT_KEYS = 100;
/** Keeps a run's row well inside the size its table allows. */
export const MAX_EVENT_IDS_IN_RESULTS = 25;
const ERROR_CATEGORY = /^[a-z_]{1,64}$/;
const ERROR_CODE = /^[0-9A-Za-z_]{1,16}$/;

function areJobResults(results: JobResults): boolean {
  const entries = Object.entries(results);
  return (
    entries.length <= MAX_RESULT_KEYS &&
    entries.every(
      ([key, value]) =>
        RESULT_KEY.test(key) &&
        (typeof value === "number"
          ? Number.isFinite(value)
          : key.endsWith("_event_ids") &&
            Array.isArray(value) &&
            value.length <= MAX_EVENT_IDS_IN_RESULTS &&
            value.every(isUuid)),
    )
  );
}

/**
 * A category and a code, the only form of failure a run may store. Discord failures
 * use their own categories, so this is wider than `DbError`, but it still has no room
 * for message text.
 */
export interface JobRunError {
  readonly category: string;
  readonly code: string | null;
}

function isJobRunError(error: JobRunError): boolean {
  return (
    ERROR_CATEGORY.test(error.category) &&
    (error.code === null || ERROR_CODE.test(error.code))
  );
}

/**
 * Takes the job's lock and starts a run, the only way to start one. Null means the job
 * is already running, or succeeded since `slotStart`, so this invocation must do nothing.
 */
export async function beginJobRun(
  db: DbClient,
  {
    jobName,
    staleAfterSeconds,
    slotStart,
  }: {
    jobName: JobName;
    staleAfterSeconds: number;
    /** When the current schedule slot began: `slotStart` in src/reminders/plan.ts. */
    slotStart: Date;
  },
): Promise<DbResult<string | null>> {
  return transact(db, async (tx) => {
    await lockJob(tx, jobName);

    // A run that stopped beating, or whose clock is ahead of the server's, is abandoned.
    await tx
      .update(jobRuns)
      .set({ status: "failed", finishedAt: dsql`now()`, error: "abandoned" })
      .where(
        and(
          eq(jobRuns.jobName, jobName),
          eq(jobRuns.status, "running"),
          or(
            lt(
              jobRuns.heartbeatAt,
              dsql`now() - make_interval(secs => ${staleAfterSeconds}::int)`,
            ),
            gt(jobRuns.heartbeatAt, dsql`clock_timestamp()`),
          ),
        ),
      );

    const [done] = await tx
      .select({ id: jobRuns.id })
      .from(jobRuns)
      .where(
        and(
          eq(jobRuns.jobName, jobName),
          eq(jobRuns.status, "succeeded"),
          gte(jobRuns.startedAt, slotStart.toISOString()),
          lte(jobRuns.startedAt, dsql`clock_timestamp()`),
        ),
      )
      .limit(1);
    if (done !== undefined) {
      return null;
    }

    const [started] = await tx
      .insert(jobRuns)
      .values({ jobName })
      .onConflictDoNothing({
        target: jobRuns.jobName,
        where: dsql`status = 'running'`,
      })
      .returning({ id: jobRuns.id });
    return started?.id ?? null;
  });
}

/**
 * One transaction at a time per job, until it ends, so a finish and a start cannot pass
 * each other. Gives up after three seconds rather than queue behind a stuck one.
 */
async function lockJob(tx: BotTx, jobName: string): Promise<void> {
  await tx.execute(
    dsql`select set_config('lock_timeout', '3s', true),
      pg_advisory_xact_lock(hashtextextended(${`job_runs:${jobName}`}::text, 0))`,
  );
}

export interface JobRunOutcome {
  id: string;
  now: Date;
  results: JobResults;
  /** Null for a run that succeeded. Stored as a category and code, never as text. */
  error: DbError | JobRunError | null;
}

/**
 * Finishes a running job, under the same lock as `beginJobRun`, so a start cannot miss a
 * success that is committing. A run that has already finished fails as `not_found`.
 */
export async function finishJobRun(
  db: DbClient,
  { id, now, results, error }: JobRunOutcome,
): Promise<DbResult<JobRun>> {
  if (!areJobResults(results) || (error !== null && !isJobRunError(error))) {
    return refused();
  }
  const finished = await transact(db, async (tx) => {
    const [run] = await tx
      .select({ jobName: jobRuns.jobName })
      .from(jobRuns)
      .where(eq(jobRuns.id, id));
    if (run === undefined) {
      return [];
    }
    await lockJob(tx, run.jobName);

    return tx
      .update(jobRuns)
      .set({
        status: error === null ? "succeeded" : "failed",
        finishedAt: dsql`least(${now.toISOString()}::timestamptz, now())`,
        results,
        error: error === null ? null : errorSummary(error),
      })
      .where(and(eq(jobRuns.id, id), eq(jobRuns.status, "running")))
      .returning();
  });
  return changedRow(
    finished.ok
      ? {
          ok: true,
          value: finished.value.map((row): JobRun => ({
            id: row.id,
            job_name: row.jobName,
            status: row.status,
            started_at: isoTimestamp(row.startedAt),
            heartbeat_at: isoTimestamp(row.heartbeatAt),
            finished_at:
              row.finishedAt === null ? null : isoTimestamp(row.finishedAt),
            results: row.results as JobRun["results"],
            error: row.error,
          })),
        }
      : finished,
  );
}

export async function getLatestJobRun(
  db: DbClient,
  { jobName }: { jobName: JobName },
): Promise<DbResult<JobRun | null>> {
  return firstRow(
    await query<JobRun>(
      db,
      sql`select id, job_name, status, started_at, heartbeat_at, finished_at, results,
        error
      from discord_bot.job_runs where job_name = ${jobName}
      order by started_at desc limit 1`,
    ),
  );
}

/** The last run that finished without a failure, however long ago. */
export async function getLatestSucceededJobRun(
  db: DbClient,
  { jobName }: { jobName: JobName },
): Promise<DbResult<JobRun | null>> {
  return firstRow(
    await query<JobRun>(
      db,
      sql`select id, job_name, status, started_at, heartbeat_at, finished_at, results,
        error
      from discord_bot.job_runs where job_name = ${jobName} and status = 'succeeded'
      order by started_at desc limit 1`,
    ),
  );
}
