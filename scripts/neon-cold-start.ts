/**
 * Times one read through the client a command uses, to check that a Neon compute
 * waking from suspend answers inside that client's deadline. Prints only the time and
 * whether the read fit: never the connection string or any row.
 *
 * Reads DATABASE_URL from the environment or .env.
 *
 * Usage:
 *   node --env-file-if-exists=.env scripts/neon-cold-start.ts
 */

import { getInteractionDb } from "../src/db/client.ts";
import { errorSummary } from "../src/db/errors.ts";
import { getGuildConfig } from "../src/db/guild-config.ts";

// Any well-formed Discord ID will do: the read's time matters, not its row.
const PLACEHOLDER_GUILD = (10n ** 17n).toString();

const db = getInteractionDb();
const started = performance.now();
const read = await getGuildConfig(db, { guildId: PLACEHOLDER_GUILD });
const elapsedMs = Math.round(performance.now() - started);
const limit = `the ${String(db.deadlineMs)} ms deadline`;

if (read.ok) {
  console.log(`One read took ${String(elapsedMs)} ms, under ${limit}.`);
} else {
  console.error(
    `The read failed after ${String(elapsedMs)} ms, against ${limit}: ${errorSummary(read.error)}`,
  );
  process.exitCode = 1;
}
