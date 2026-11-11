import type { DbClient } from "./client.ts";
import { rest } from "./internal.ts";
import {
  errorSummary,
  refused,
  type DbError,
  type DbResult,
} from "./errors.ts";
import { exactlyOne, nullableUuidValue, oneOrNone } from "./result.ts";
import { parseJobRun, type JobRun } from "./types.ts";
import { isInstant, isUuid } from "./validate.ts";

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

function isJobName(value: unknown): value is JobName {
  return value === "reminders" || value === "health_check";
}

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

function isWholeNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Takes the job's lock and starts a run, the only way to start one. Null means the job
 * is already running, or succeeded in the current schedule slot, so this invocation
 * must do nothing.
 */
export async function beginJobRun(
  db: DbClient,
  {
    jobName,
    staleAfterSeconds,
  }: {
    jobName: JobName;
    staleAfterSeconds: number;
  },
): Promise<DbResult<string | null>> {
  if (!isJobName(jobName) || !isWholeNumber(staleAfterSeconds)) {
    return refused();
  }
  return nullableUuidValue(
    await rest(db).rpc("begin_job_run", {
      p_job_name: jobName,
      p_stale_after_seconds: staleAfterSeconds,
    }),
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
  if (
    !isUuid(id) ||
    !isInstant(now) ||
    !areJobResults(results) ||
    (error !== null && !isJobRunError(error))
  ) {
    return refused();
  }
  return exactlyOne(
    await rest(db).rpc("finish_job_run", {
      p_id: id,
      p_finished_at: now.toISOString(),
      p_results: results,
      p_error: error === null ? null : errorSummary(error),
    }),
    parseJobRun,
  );
}

export async function getLatestJobRun(
  db: DbClient,
  { jobName }: { jobName: JobName },
): Promise<DbResult<JobRun | null>> {
  if (!isJobName(jobName)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("job_runs")
      .select(
        "id,job_name,status,started_at,heartbeat_at,finished_at,results,error",
      )
      .eq("job_name", jobName)
      .order("started_at", { ascending: false })
      .limit(1),
    parseJobRun,
  );
}

/** The last run that finished without a failure, however long ago. */
export async function getLatestSucceededJobRun(
  db: DbClient,
  { jobName }: { jobName: JobName },
): Promise<DbResult<JobRun | null>> {
  if (!isJobName(jobName)) {
    return refused();
  }
  return oneOrNone(
    await rest(db)
      .from("job_runs")
      .select(
        "id,job_name,status,started_at,heartbeat_at,finished_at,results,error",
      )
      .eq("job_name", jobName)
      .eq("status", "succeeded")
      .order("started_at", { ascending: false })
      .limit(1),
    parseJobRun,
  );
}
