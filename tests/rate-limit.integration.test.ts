import { afterAll, describe, expect, it, setSystemTime } from "bun:test";
import { resolve } from "node:path";

import {
  assertRateLimit,
  pruneRateLimits,
  takeToken,
} from "../packages/api/src/rate-limit";
import { db, rateLimits } from "../packages/db/src/index";

const { eq, like } =
  await import("../packages/db/node_modules/drizzle-orm/index.js");

const MINUTE = 60_000;
const OPTIONS = { limit: 3, intervalMs: MINUTE };

const suffix = crypto.randomUUID().slice(0, 8);
const key = (name: string) => `rl-test-${suffix}:${name}`;

/**
 * Each test runs at its own instant in 2090, a day after the last. The clock
 * only ever moves forward, so every test is past the limiter's sweep interval
 * and no test can see another's windows. Minute-aligned, so a window starts
 * exactly at the instant.
 */
let instant = Date.UTC(2090, 0, 1);
function startTest() {
  instant += 24 * 60 * MINUTE;
  setSystemTime(instant);
  return instant;
}

/** A separate process takes `hits` tokens; resolves to how many it was allowed. */
async function otherInstance(
  at: number,
  keyName: string,
  { limit, intervalMs }: typeof OPTIONS,
  hits: number,
) {
  const proc = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dirname, "helpers/rate-limit-instance.ts"),
      keyName,
      String(limit),
      String(intervalMs),
      String(hits),
    ],
    {
      env: { ...process.env, RATE_LIMIT_NOW: String(at) },
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const out = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return (JSON.parse(out) as { allowed: number }).allowed;
}

async function windowStarts(keyName: string) {
  const rows = await db
    .select({ windowStart: rateLimits.windowStart })
    .from(rateLimits)
    .where(eq(rateLimits.key, keyName));
  return rows.map((row) => row.windowStart.getTime());
}

describe.skipIf(!process.env.DATABASE_URL)("rate limiter on Postgres", () => {
  afterAll(async () => {
    setSystemTime();
    await db.delete(rateLimits).where(like(rateLimits.key, key("%")));
  });

  it("allows the limit, then refuses, per key", async () => {
    startTest();

    for (let hit = 0; hit < OPTIONS.limit; hit++) {
      expect(await takeToken(db, key("a"), OPTIONS)).toBe(true);
    }
    expect(await takeToken(db, key("a"), OPTIONS)).toBe(false);
    expect(await takeToken(db, key("b"), OPTIONS)).toBe(true);
  });

  it("starts a fresh count when the next window opens", async () => {
    const start = startTest();
    for (let hit = 0; hit < OPTIONS.limit; hit++) {
      await takeToken(db, key("roll"), OPTIONS);
    }
    expect(await takeToken(db, key("roll"), OPTIONS)).toBe(false);

    setSystemTime(start + MINUTE - 1);
    expect(await takeToken(db, key("roll"), OPTIONS)).toBe(false);

    setSystemTime(start + MINUTE);
    for (let hit = 0; hit < OPTIONS.limit; hit++) {
      expect(await takeToken(db, key("roll"), OPTIONS)).toBe(true);
    }
    expect(await takeToken(db, key("roll"), OPTIONS)).toBe(false);
  });

  it("throws TOO_MANY_REQUESTS once over the limit", async () => {
    startTest();
    for (let hit = 0; hit < OPTIONS.limit; hit++) {
      await assertRateLimit(db, key("assert"), OPTIONS);
    }

    await expect(
      assertRateLimit(db, key("assert"), OPTIONS),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("admits exactly the limit from a simultaneous burst", async () => {
    startTest();
    const burst = { limit: 10, intervalMs: MINUTE };

    const results = await Promise.all(
      Array.from({ length: 40 }, () => takeToken(db, key("burst"), burst)),
    );

    expect(results.filter(Boolean)).toHaveLength(burst.limit);
  });

  it("holds one limit across two instances", async () => {
    const at = startTest();
    const shared = { limit: 10, intervalMs: MINUTE };

    // This instance spends the whole limit; another process, with its own
    // pool, is then refused every hit.
    for (let hit = 0; hit < shared.limit; hit++) {
      expect(await takeToken(db, key("serial"), shared)).toBe(true);
    }
    expect(await otherInstance(at, key("serial"), shared, 5)).toBe(0);

    // Both hitting at once still add up to the limit, not twice it.
    const [mine, theirs] = await Promise.all([
      Promise.all(
        Array.from({ length: 12 }, () => takeToken(db, key("both"), shared)),
      ),
      otherInstance(at, key("both"), shared, 12),
    ]);
    expect(mine.filter(Boolean).length + theirs).toBe(shared.limit);
  }, 30_000);

  it("pruneRateLimits drops rows past an hour and keeps newer ones", async () => {
    const now = startTest();
    const hour = 60 * MINUTE;
    await db.insert(rateLimits).values([
      { key: key("prune"), windowStart: new Date(now - 2 * hour), count: 4 },
      {
        key: key("prune"),
        windowStart: new Date(now - hour - MINUTE),
        count: 4,
      },
      { key: key("prune"), windowStart: new Date(now - 10 * MINUTE), count: 4 },
      { key: key("prune"), windowStart: new Date(now), count: 4 },
    ]);

    await pruneRateLimits(db, now);

    expect((await windowStarts(key("prune"))).sort()).toEqual([
      now - 10 * MINUTE,
      now,
    ]);
  });

  it("sweeps stale rows from a hit, at most once per sweep interval", async () => {
    const now = startTest();
    const stale = (minutesAgo: number) => ({
      key: key("sweep"),
      windowStart: new Date(now - minutesAgo * MINUTE),
      count: 1,
    });

    // The first hit after the interval sweeps.
    await db.insert(rateLimits).values(stale(180));
    await takeToken(db, key("sweep-hit"), OPTIONS);
    expect(await windowStarts(key("sweep"))).toEqual([]);

    // A second hit a minute later does not.
    setSystemTime(now + MINUTE);
    await db.insert(rateLimits).values(stale(240));
    await takeToken(db, key("sweep-hit"), OPTIONS);
    expect(await windowStarts(key("sweep"))).toHaveLength(1);

    // Five minutes after the first sweep, one does.
    setSystemTime(now + 5 * MINUTE);
    await takeToken(db, key("sweep-hit"), OPTIONS);
    expect(await windowStarts(key("sweep"))).toEqual([]);
  });
});
