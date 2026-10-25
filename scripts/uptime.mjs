import { readFileSync, writeFileSync } from "node:fs";

import { siteUrl } from "./site-url.mjs";

/**
 * One uptime probe for the /status page. Reads the history JSON at the path
 * given as the first argument, records this run, and writes it back.
 *
 * Nothing here wakes the Neon database. The public site is a static page off
 * Vercel's CDN. The sign-in page runs a function, but with no session cookie
 * Auth.js never queries the database.
 * /api/health runs a query, and the home page and /events revalidate against
 * the database, so probing those every ten minutes would keep compute warm.
 *
 * Exits non-zero when anything is down so the workflow run fails and GitHub
 * emails whoever watches the repo.
 */
const file = process.argv[2];
if (!file) throw new Error("Usage: node scripts/uptime.mjs <uptime.json>");

const base = siteUrl(process.env.UPTIME_URL);

/** [id, name shown on /status, path, text the response must contain] */
const checks = [
  ["site", "Public website", "/about", "SASE"],
  ["portal", "Member portal", "/portal/signin", "Continue with Google"],
];

/** One sample per run for the last 24 hours, at a ten-minute cadence. */
const keepSamples = 144;
const keepDays = 90;

/** Days are the chapter's, not UTC's, so a bar matches the date on campus. */
const chapterDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

function load() {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version === 2) return data;
  } catch {
    // First run, or the data branch does not exist yet.
  }
  return { recent: [], days: [], incidents: [] };
}

/**
 * Response time is time to first byte: what the server took to answer, not
 * how long the runner took to download the page.
 */
async function probe(path, expected) {
  const startedAt = Date.now();
  try {
    const response = await fetch(base + path, {
      redirect: "follow",
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - startedAt;
    const body = await response.text();
    if (!response.ok)
      return { up: false, ms, detail: `HTTP ${response.status}` };
    if (!body.includes(expected)) {
      return {
        up: false,
        ms,
        detail: `HTTP ${response.status}, unexpected page`,
      };
    }
    return { up: true, ms };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      up: false,
      ms: null,
      detail: timedOut ? "No response in 10 s" : "Could not connect",
    };
  }
}

// Open the connection first so DNS and the TLS handshake from a fresh
// runner are not billed to whichever check happens to run first.
await fetch(`${base}/robots.txt`, { signal: AbortSignal.timeout(10_000) })
  .then((response) => response.arrayBuffer())
  .catch(() => {});

const checkedAt = new Date();
const results = {};
for (const [id, , path, expected] of checks) {
  results[id] = await probe(path, expected);
  const { up, ms, detail } = results[id];
  console.log(`${up ? "ok  " : "FAIL"} ${path} ${ms ?? "-"}ms ${detail ?? ""}`);
}
const allUp = Object.values(results).every((result) => result.up);

const history = load();
const at = checkedAt.toISOString();
const date = chapterDate.format(checkedAt);
const ninetyDaysAgo = checkedAt.getTime() - keepDays * 24 * 60 * 60 * 1000;

history.recent.push({
  at,
  ms: Object.fromEntries(
    checks.map(([id]) => [id, results[id].up ? results[id].ms : null]),
  ),
});

let today = history.days.find((day) => day.date === date);
if (!today) {
  today = { date, checks: 0, up: 0, byCheck: {} };
  history.days.push(today);
}
today.checks += 1;
if (allUp) today.up += 1;
for (const [id] of checks) {
  const bucket = (today.byCheck[id] ??= { checks: 0, up: 0, totalMs: 0 });
  bucket.checks += 1;
  if (results[id].up) {
    bucket.up += 1;
    bucket.totalMs += results[id].ms;
  }
}

for (const [id] of checks) {
  if (!results[id].up) {
    history.incidents.push({ at, id, detail: results[id].detail });
  }
}

history.days.sort((a, b) => a.date.localeCompare(b.date));
writeFileSync(
  file,
  JSON.stringify({
    version: 2,
    site: base,
    checkedAt: at,
    checks: checks.map(([id, name, path]) => ({ id, name, path })),
    latest: Object.fromEntries(
      checks.map(([id]) => [id, { up: results[id].up, ms: results[id].ms }]),
    ),
    recent: history.recent.slice(-keepSamples),
    days: history.days.slice(-keepDays),
    incidents: history.incidents.filter(
      (incident) => new Date(incident.at).getTime() >= ninetyDaysAgo,
    ),
  }) + "\n",
);

if (!allUp) {
  console.error(`Something is down on ${base}`);
  process.exitCode = 1;
}
