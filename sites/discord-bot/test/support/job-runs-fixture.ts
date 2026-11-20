import type { Connection } from "../db/harness.ts";

export interface JobRunFixture {
  jobName?: string;
  status: "succeeded" | "failed";
  /** Defaults to the current time. */
  startedAt?: Date;
  results?: string;
  error?: string | null;
}

/**
 * Writes a finished run as the connection's own role, which must be the owner or a
 * superuser. The bot's role has no direct write to this table, so a test that needs a
 * run in a given state sets it up here.
 */
export async function insertFinishedJobRun(
  db: Connection,
  {
    jobName = "reminders",
    status,
    startedAt,
    results = "{}",
    error = null,
  }: JobRunFixture,
): Promise<void> {
  await db.query(
    `INSERT INTO public.job_runs (job_name, status, started_at, heartbeat_at, finished_at, results, error)
     VALUES ($1, $2, coalesce($3::timestamptz, now()), coalesce($3::timestamptz, now()),
             coalesce($3::timestamptz, now()), $4::jsonb, $5)`,
    [jobName, status, startedAt ?? null, results, error],
  );
}
