import { TRPCError } from "@trpc/server";
import { lt, sql } from "drizzle-orm";

import { rateLimits, type db as appDb } from "@buzz/db";

/** All the limiter needs of a database handle, so a fake can stand in. */
type LimiterDb = Pick<typeof appDb, "insert" | "delete">;

export type RateLimitOptions = {
  limit: number;
  intervalMs: number;
};

/**
 * Rows are dead once their window ends. Keeping them an hour is the slack that
 * lets the sweep skip the question of which window length wrote a row, so no
 * limit may use a window longer than this.
 */
const PRUNE_AFTER_MS = 60 * 60_000;

/** Each instance sweeps at most this often, starting with its first hit. */
const PRUNE_EVERY_MS = 5 * 60_000;
let prunedAt = 0;

/**
 * A fixed-window counter in Postgres, so every serverless instance counts into
 * the same row. A window is `intervalMs` long and starts on a multiple of it;
 * the call that makes the count exceed `limit` is refused, and the next window
 * starts from zero. A caller can land `limit` hits at the end of one window and
 * `limit` more at the start of the next, which a code-guessing cap tolerates.
 *
 * The window comes from this instance's clock, not the database's: instances
 * agree to within NTP skew, which only blurs a boundary, and a test can move it.
 *
 * Pass the pool handle, never a transaction: a refused hit has to stay counted
 * when the caller's own work rolls back.
 */
export async function takeToken(
  db: LimiterDb,
  key: string,
  { limit, intervalMs }: RateLimitOptions,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / intervalMs) * intervalMs);

  const [row] = await db
    .insert(rateLimits)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.windowStart],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count });

  if (now - prunedAt >= PRUNE_EVERY_MS) {
    prunedAt = now;
    // Housekeeping: a failed sweep leaves rows for the next one.
    await pruneRateLimits(db, now).catch(() => undefined);
  }

  return row!.count <= limit;
}

export async function assertRateLimit(
  db: LimiterDb,
  key: string,
  options: RateLimitOptions,
) {
  if (!(await takeToken(db, key, options))) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Try again shortly.",
    });
  }
}

export async function pruneRateLimits(db: LimiterDb, now = Date.now()) {
  await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, new Date(now - PRUNE_AFTER_MS)));
}

export const CHECK_IN_LIMIT = {
  limit: 10,
  intervalMs: 60_000,
} as const;

export const MANUAL_CHECK_IN_LIMIT = {
  limit: 30,
  intervalMs: 60_000,
} as const;

export const REGENERATE_CODE_LIMIT = {
  limit: 10,
  intervalMs: 60_000,
} as const;

export const EXPORT_ROSTER_LIMIT = {
  limit: 5,
  intervalMs: 60_000,
} as const;

export const EXPORT_ATTENDANCE_LIMIT = {
  limit: 5,
  intervalMs: 60_000,
} as const;

export const MENTORSHIP_ENROLL_LIMIT = {
  limit: 10,
  intervalMs: 60_000,
} as const;

export const MENTORSHIP_AWARD_LIMIT = {
  limit: 30,
  intervalMs: 60_000,
} as const;

export const COMMITTEE_APPLY_LIMIT = {
  limit: 10,
  intervalMs: 60_000,
} as const;

export const EXPORT_COMMITTEE_LIMIT = {
  limit: 5,
  intervalMs: 60_000,
} as const;

export const RESUME_UPLOAD_LIMIT = {
  limit: 8,
  intervalMs: 60_000,
} as const;

export const ELECTION_ACTION_LIMIT = {
  limit: 20,
  intervalMs: 60_000,
} as const;

export const RSVP_LIMIT = {
  limit: 20,
  intervalMs: 60_000,
} as const;

export const LEADERBOARD_PREF_LIMIT = {
  limit: 20,
  intervalMs: 60_000,
} as const;

export const PROFILE_LIMIT = {
  limit: 20,
  intervalMs: 60_000,
} as const;

export const NOTIFICATION_PREFS_LIMIT = {
  limit: 20,
  intervalMs: 60_000,
} as const;

export const HEADSHOT_UPLOAD_LIMIT = {
  limit: 6,
  intervalMs: 60_000,
} as const;

export const PAGE_IMAGE_UPLOAD_LIMIT = {
  limit: 12,
  intervalMs: 60_000,
} as const;
