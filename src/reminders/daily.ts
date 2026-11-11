/**
 * What one cron invocation does. The endpoint only checks the secret and turns the
 * outcome into a fixed response.
 */

import { getDb, withDeadline, type DbClient } from "../db/client.ts";
import { errorSummary } from "../db/errors.ts";
import { expireInteractionClaims } from "../db/interaction-claims.ts";
import { createDiscordClient, type DiscordClient } from "../discord/client.ts";
import { ConfigError } from "../lib/config-error.ts";
import { getAllowedGuildIds } from "../lib/env.ts";
import { jobFreshness, runHealthCheck } from "./health.ts";
import {
  DATABASE_CALL_MS,
  DEFAULT_LIMITS,
  DISCORD_OPERATION_MS,
  managedChannelCheck,
  runReminders,
} from "./run.ts";

export interface DailyDependencies {
  readonly db: DbClient;
  readonly client: DiscordClient;
  readonly allowedGuildIds: ReadonlySet<string>;
}

function log(line: string): void {
  console.warn(line);
}

/** Built on each call, so a warm function cannot carry a client's memory to tomorrow. */
function productionDependencies(): DailyDependencies {
  const db = getDb();
  return {
    db,
    client: createDiscordClient({
      check: managedChannelCheck(db),
      budget: { operationMs: DISCORD_OPERATION_MS },
    }),
    allowedGuildIds: getAllowedGuildIds(),
  };
}

/** True unless something failed, so the platform's logs show a failed invocation. */
export async function runDailyJobs(
  dependencies?: DailyDependencies,
): Promise<boolean> {
  try {
    const shared = dependencies ?? productionDependencies();
    // One time budget and one client for both, so a token refused by the first is not
    // tried again by the second.
    const startedMs = Date.now();
    const deadlineMs = startedMs + DEFAULT_LIMITS.workMs;
    // Read first, because the success this run is about to record would hide a gap before it.
    const remindersFreshness = await jobFreshness(
      withDeadline(shared.db, DATABASE_CALL_MS),
      "reminders",
      new Date(),
    );
    // The run's limits assume it has the function's time to itself.
    const spentMs = Date.now() - startedMs;
    const reminders = await runReminders({
      ...shared,
      log,
      limits: {
        workMs: DEFAULT_LIMITS.workMs - spentMs,
        hardStopMs: DEFAULT_LIMITS.hardStopMs - spentMs,
      },
    });
    if (reminders.status === "failed") {
      log(`Reminder run failed: ${reminders.error ?? "unrecorded"}`);
    }
    if (Date.now() >= deadlineMs) {
      // Its own reads and record could pass the function's limit. Reminders went first,
      // and this job's slot is still open for the recovery cron.
      log("Health check left for the next cron: out of time");
      return reminders.status !== "failed";
    }
    const health = await runHealthCheck({
      ...shared,
      log,
      deadlineMs,
      remindersFreshness,
    });
    if (health.status === "failed") {
      log(`Health check failed: ${health.error ?? "unrecorded"}`);
    }
    const expired = await expireInteractionClaims(shared.db);
    if (!expired.ok) {
      log(`Claim expiry failed: ${errorSummary(expired.error)}`);
    }
    return (
      reminders.status !== "failed" && health.status !== "failed" && expired.ok
    );
  } catch (error) {
    // ConfigError messages are written to be safe to log. Others could quote data.
    log(
      error instanceof ConfigError
        ? error.message
        : `Daily jobs failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
    return false;
  }
}
