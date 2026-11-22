/**
 * One serverless instance of the limiter, as its own process: its own module
 * state and its own database pool, sharing nothing with the test that spawned
 * it except the database. Takes `hits` tokens for `key` one after another and
 * prints how many were allowed.
 *
 *   bun tests/helpers/rate-limit-instance.ts <key> <limit> <intervalMs> <hits>
 *
 * `RATE_LIMIT_NOW` pins this instance's clock to the parent's fake one.
 */
import { takeToken } from "../../packages/api/src/rate-limit";
import { db } from "../../packages/db/src/index";

const [key, limit, intervalMs, hits] = process.argv.slice(2);

const pinned = process.env.RATE_LIMIT_NOW;
if (pinned) Date.now = () => Number(pinned);

let allowed = 0;
for (let hit = 0; hit < Number(hits); hit++) {
  if (
    await takeToken(db, key!, {
      limit: Number(limit),
      intervalMs: Number(intervalMs),
    })
  ) {
    allowed++;
  }
}

console.log(JSON.stringify({ allowed }));
process.exit(0);
