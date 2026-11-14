/**
 * The daily health check: one GET per managed channel, and a freshness flag for the
 * jobs themselves.
 *
 * A channel is disabled only on an explicit Unknown Channel from a GET of that channel.
 * A 404 with no such code, a permissions failure or an outage flags it and changes
 * nothing, because none of them shows the channel is gone, and disabling it would stop
 * reminders until an admin noticed.
 *
 * A cron that stops firing writes no rows, so nothing in a run can report that it did
 * not run. `jobFreshness` is what a separate monitor should call, or do the same sum
 * on `job_runs` directly: the latest `succeeded` row's `started_at` for a job. Each
 * health check also stores the answer it saw, in `reminders_stale` and
 * `health_check_stale`. The daily job reads the reminders answer before it runs them,
 * since their own success would otherwise hide the gap, so a gap that has just ended stays
 * visible in the row of the day it ended.
 *
 * It also copies out what the latest reminder run left for a person to look at, such as
 * reminders put off by the message cap, even though that run succeeded. Event IDs stay in
 * that run's own row.
 */

import { withDeadline, type DbClient } from "../db/client.ts";
import { errorSummary } from "../db/errors.ts";
import {
  beginJobRun,
  finishJobRun,
  getLatestJobRun,
  getLatestSucceededJobRun,
  type JobName,
  type JobResults,
  type JobRunError,
} from "../db/job-runs.ts";
import {
  listActiveManagedChannels,
  markChannelUnavailable,
} from "../db/managed-channels.ts";
import {
  DiscordClientError,
  DiscordErrorCode,
  actionForFailure,
  type DiscordClient,
  type DiscordFailure,
} from "../discord/client.ts";
import { FORUM_CHANNEL_TYPES } from "../discord/verify.ts";
import { slotStart } from "./plan.ts";
import { DATABASE_CALL_MS, DEFAULT_LIMITS, LOCK_STALE_SECONDS } from "./run.ts";

const HOUR_MS = 3_600_000;
/** A daily job fires within its hour, so two runs can be up to 25 hours apart. */
export const MAX_RUN_AGE_MS = 26 * HOUR_MS;
/** The database's clock and ours can disagree by this much without it meaning anything. */
const CLOCK_TOLERANCE_MS = 300_000;
/** Counts in a reminder run's results that mean a person should look, though it succeeded. */
const REMINDER_ATTENTION_COUNTS = [
  "deferred_cap",
  "threads_missing",
  "events_stopped",
] as const;

export type JobFreshness =
  | { readonly state: "fresh"; readonly ageHours: number }
  | { readonly state: "stale"; readonly ageHours: number }
  /**
   * The latest success is dated in the future, which a real run cannot do. It shows nothing
   * about the job, and would otherwise look like the freshest run there could be.
   */
  | { readonly state: "future" }
  /** No run has ever succeeded. */
  | { readonly state: "never" }
  /** The check could not read `job_runs`, which does not show the job is well. */
  | { readonly state: "unknown" };

export async function jobFreshness(
  db: DbClient,
  jobName: JobName,
  now: Date,
): Promise<JobFreshness> {
  const latest = await getLatestSucceededJobRun(db, { jobName });
  if (!latest.ok) {
    return { state: "unknown" };
  }
  if (latest.value === null) {
    return { state: "never" };
  }
  const ageMs = now.getTime() - new Date(latest.value.started_at).getTime();
  if (ageMs < -CLOCK_TOLERANCE_MS) {
    return { state: "future" };
  }
  const ageHours = Math.max(0, Math.floor(ageMs / HOUR_MS));
  return ageMs > MAX_RUN_AGE_MS
    ? { state: "stale", ageHours }
    : { state: "fresh", ageHours };
}

export interface HealthDependencies {
  readonly db: DbClient;
  readonly client: DiscordClient;
  readonly allowedGuildIds: ReadonlySet<string>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
  /** Stop before this instant, in milliseconds, so the function can record itself. */
  readonly deadlineMs?: number;
  /** What was true before this invocation ran the reminders. Read here if left out. */
  readonly remindersFreshness?: JobFreshness;
}

export type HealthResult =
  | { readonly status: "duplicate" }
  | {
      readonly status: "succeeded" | "failed";
      readonly results: JobResults;
      readonly error: string | null;
    };

function stopError(failure: DiscordFailure): JobRunError {
  return failure.kind === "unauthorized"
    ? { category: "discord_unauthorized", code: "401" }
    : { category: "discord_rate_limited", code: "429" };
}

function freshnessCounts(
  prefix: "reminders" | "health_check",
  freshness: JobFreshness,
): Record<string, number> {
  switch (freshness.state) {
    case "fresh":
      return {
        [`${prefix}_stale`]: 0,
        [`${prefix}_age_hours`]: freshness.ageHours,
      };
    case "stale":
      return {
        [`${prefix}_stale`]: 1,
        [`${prefix}_age_hours`]: freshness.ageHours,
      };
    case "future":
      return { [`${prefix}_stale`]: 1, [`${prefix}_future_dated`]: 1 };
    case "never":
      return { [`${prefix}_stale`]: 1, [`${prefix}_never_run`]: 1 };
    case "unknown":
      return { [`${prefix}_stale`]: 1, [`${prefix}_unreadable`]: 1 };
  }
}

export async function runHealthCheck(
  dependencies: HealthDependencies,
): Promise<HealthResult> {
  const { client, allowedGuildIds } = dependencies;
  const db = withDeadline(dependencies.db, DATABASE_CALL_MS);
  const clock = dependencies.now ?? (() => new Date());
  const log =
    dependencies.log ??
    ((line) => {
      console.warn(line);
    });
  const deadlineMs =
    dependencies.deadlineMs ?? clock().getTime() + DEFAULT_LIMITS.workMs;

  // Read first: a run's own new row must not hide a gap before it.
  const remindersFresh =
    dependencies.remindersFreshness ??
    (await jobFreshness(db, "reminders", clock()));
  const ownFresh = await jobFreshness(db, "health_check", clock());

  const lock = await beginJobRun(db, {
    jobName: "health_check",
    staleAfterSeconds: LOCK_STALE_SECONDS,
    slotStart: new Date(slotStart(clock())),
  });
  if (!lock.ok) {
    return { status: "failed", results: {}, error: errorSummary(lock.error) };
  }
  if (lock.value === null) {
    return { status: "duplicate" };
  }

  const results: Record<string, number> = {
    ...freshnessCounts("reminders", remindersFresh),
    ...freshnessCounts("health_check", ownFresh),
    channels_checked: 0,
    channels_ok: 0,
  };
  const count = (key: string) => {
    results[key] = (results[key] ?? 0) + 1;
  };
  for (const [job, freshness] of [
    ["reminders", remindersFresh],
    ["health_check", ownFresh],
  ] as const) {
    if (freshness.state !== "fresh") {
      log(`Job ${job} has no recent successful run: ${freshness.state}`);
    }
  }

  const latestReminders = await getLatestJobRun(db, { jobName: "reminders" });
  if (latestReminders.ok) {
    for (const key of REMINDER_ATTENTION_COUNTS) {
      const value = latestReminders.value?.results[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0
      ) {
        results[`reminders_${key}`] = value;
        log(`Latest reminder run needs a look: ${key} ${String(value)}`);
      }
    }
  } else {
    count("reminders_results_unreadable");
  }

  let error: JobRunError | null = null;
  const channels = await listActiveManagedChannels(db);
  if (channels.ok) {
    if (channels.value.truncated) {
      count("truncated");
    }
    for (const { guild_id: guildId, channel_id: channelId } of channels.value
      .rows) {
      if (error !== null) {
        break;
      }
      if (clock().getTime() >= deadlineMs) {
        count("channels_not_reached");
        continue;
      }
      if (!allowedGuildIds.has(guildId)) {
        count("guilds_not_allowed");
        continue;
      }
      count("channels_checked");
      try {
        const channel = await client.getChannel(guildId, channelId);
        if (channel.guildId !== guildId) {
          count("channels_wrong_guild");
          log(`Channel ${channelId} is not in its guild`);
        } else if (!FORUM_CHANNEL_TYPES.has(channel.type)) {
          count("channels_not_forum");
          log(`Channel ${channelId} is not a forum`);
        } else {
          count("channels_ok");
        }
      } catch (caught) {
        const failure =
          caught instanceof DiscordClientError ? caught.failure : null;
        if (failure !== null && actionForFailure(failure) === "stop_run") {
          error = stopError(failure);
        } else if (
          failure?.kind === "channel_unavailable" &&
          failure.code === DiscordErrorCode.UnknownChannel
        ) {
          const marked = await markChannelUnavailable(db, {
            guildId,
            channelId,
          });
          if (marked.ok) {
            count("channels_gone");
            log(`Channel ${channelId} is gone and was marked unavailable`);
          } else {
            count("channels_unknown");
          }
        } else if (failure?.kind === "channel_unavailable") {
          count("channels_inaccessible");
          log(`Channel ${channelId} is not accessible to the bot`);
        } else {
          count("channels_unknown");
        }
      }
    }
  } else {
    error = channels.error;
  }

  const finished = await finishJobRun(db, {
    id: lock.value,
    now: clock(),
    results,
    error,
  });
  if (!finished.ok) {
    log(`Health check could not be recorded: ${errorSummary(finished.error)}`);
  }
  return {
    status: error === null && finished.ok ? "succeeded" : "failed",
    results,
    error: error === null ? null : errorSummary(error),
  };
}
