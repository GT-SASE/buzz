/**
 * In-process token bucket. Soft under multi-instance deploys — each instance
 * has its own counters — but enough to stop a single signed-in account from
 * hammering check-in or CSV export on one warm lambda.
 */

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitOptions = {
  /** Max tokens in the bucket. */
  limit: number;
  /** How often one token is restored, in ms. */
  intervalMs: number;
};

export function takeToken(
  key: string,
  { limit, intervalMs }: RateLimitOptions,
): boolean {
  const now = Date.now();
  const current = buckets.get(key) ?? { tokens: limit, updatedAt: now };
  const elapsed = now - current.updatedAt;
  const restored = Math.floor(elapsed / intervalMs);
  const tokens = Math.min(limit, current.tokens + restored);
  const updatedAt =
    restored > 0 ? current.updatedAt + restored * intervalMs : current.updatedAt;

  if (tokens <= 0) {
    buckets.set(key, { tokens: 0, updatedAt });
    return false;
  }

  buckets.set(key, { tokens: tokens - 1, updatedAt });
  return true;
}

/** Test helper. */
export function resetRateLimits() {
  buckets.clear();
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
