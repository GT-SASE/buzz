import { TRPCError } from "@trpc/server";

type Bucket = {
  tokens: number;
  updatedAt: number;
  fullAt: number;
};

const buckets = new Map<string, Bucket>();

const SWEEP_INTERVAL_MS = 60_000;
let sweptAt = 0;

function sweep(now: number) {
  if (now - sweptAt < SWEEP_INTERVAL_MS) return;
  sweptAt = now;
  for (const [key, bucket] of buckets) {
    if (now >= bucket.fullAt) buckets.delete(key);
  }
}

export type RateLimitOptions = {
  limit: number;
  intervalMs: number;
};

export function takeToken(
  key: string,
  { limit, intervalMs }: RateLimitOptions,
): boolean {
  const now = Date.now();
  sweep(now);

  const current = buckets.get(key);
  const elapsed = current ? now - current.updatedAt : 0;
  const restored = current ? Math.floor(elapsed / intervalMs) : 0;
  const tokens = current ? Math.min(limit, current.tokens + restored) : limit;
  const updatedAt =
    current && restored > 0
      ? current.updatedAt + restored * intervalMs
      : (current?.updatedAt ?? now);

  if (tokens <= 0) {
    buckets.set(key, {
      tokens: 0,
      updatedAt,
      fullAt: updatedAt + limit * intervalMs,
    });
    return false;
  }

  const remaining = tokens - 1;
  buckets.set(key, {
    tokens: remaining,
    updatedAt,
    fullAt: updatedAt + (limit - remaining) * intervalMs,
  });
  return true;
}

export function assertRateLimit(key: string, options: RateLimitOptions) {
  if (!takeToken(key, options)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Try again shortly.",
    });
  }
}

export function resetRateLimits() {
  buckets.clear();
  sweptAt = 0;
}

export function rateLimitBucketCount() {
  return buckets.size;
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
