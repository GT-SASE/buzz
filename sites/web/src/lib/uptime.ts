/**
 * Shape of uptime.json, written by scripts/uptime.mjs on the uptime-data
 * branch. A run is "up" only when every check in it passed. Day buckets use
 * the chapter's date (America/New_York); `totalMs` sums the response time of
 * the checks that came back up.
 */
type Bucket = { checks: number; up: number; totalMs: number };

export type UptimeHistory = {
  version: 2;
  site: string;
  checkedAt: string;
  checks: { id: string; name: string; path: string }[];
  latest: Record<string, { up: boolean; ms: number | null }>;
  recent: { at: string; ms: Record<string, number | null> }[];
  days: {
    date: string;
    checks: number;
    up: number;
    byCheck: Record<string, Bucket>;
  }[];
  incidents: { at: string; id: string; detail: string }[];
};

/** Read in the browser, so the status page never runs a function. */
export const uptimeDataUrl =
  "https://raw.githubusercontent.com/GT-SASE/buzz/uptime-data/uptime.json";

/** Days drawn as bars, matching what the probe keeps. */
export const barDays = 90;

/**
 * The probe runs every ten minutes, but scheduled GitHub Actions can lag by
 * a quarter of an hour or more. Past this, the last result is not "current".
 */
const staleAfterMs = 45 * 60 * 1000;

const chapterDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
});

export type FeatureSummary = {
  id: string;
  name: string;
  up: boolean;
  /** Over the last 90 days. */
  uptime: number | null;
  /** Over the last 30 days, checks that came back up only. */
  averageMs: number | null;
  /** Last 24 hours, oldest first; null where the check failed. */
  recent: { at: Date; ms: number | null }[];
};

export type DaySummary = {
  date: string;
  percent: number | null;
  features: {
    id: string;
    name: string;
    percent: number | null;
    averageMs: number | null;
  }[];
  incidents: { at: Date; name: string; detail: string }[];
};

export type UptimeSummary = {
  state: "up" | "down" | "stale";
  checkedAt: Date;
  windows: { days: number; percent: number | null }[];
  features: FeatureSummary[];
  /** Oldest first, one per day ending today. */
  days: DaySummary[];
};

function ratio(buckets: { checks: number; up: number }[]) {
  const checks = buckets.reduce((sum, bucket) => sum + bucket.checks, 0);
  if (checks === 0) return null;
  return (buckets.reduce((sum, bucket) => sum + bucket.up, 0) / checks) * 100;
}

function average(buckets: Bucket[]) {
  const up = buckets.reduce((sum, bucket) => sum + bucket.up, 0);
  if (up === 0) return null;
  return Math.round(
    buckets.reduce((sum, bucket) => sum + bucket.totalMs, 0) / up,
  );
}

export function summarize(history: UptimeHistory, now: Date): UptimeSummary {
  const checkedAt = new Date(history.checkedAt);
  const byDate = new Map(history.days.map((day) => [day.date, day]));
  const names = new Map(history.checks.map((check) => [check.id, check.name]));

  // Step back from noon UTC on the chapter's today, which is never near a
  // date line, so a DST change cannot skip or repeat a day.
  const today = new Date(`${chapterDate.format(now)}T12:00:00Z`);
  const dates: string[] = [];
  for (let back = barDays - 1; back >= 0; back--) {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - back);
    dates.push(day.toISOString().slice(0, 10));
  }

  const lastDays = (count: number) =>
    dates
      .slice(-count)
      .map((date) => byDate.get(date))
      .filter((day) => day !== undefined);

  const buckets = (id: string, count: number) =>
    lastDays(count)
      .map((day) => day.byCheck[id])
      .filter((bucket) => bucket !== undefined);

  return {
    state:
      now.getTime() - checkedAt.getTime() > staleAfterMs
        ? "stale"
        : history.checks.every((check) => history.latest[check.id]?.up)
          ? "up"
          : "down",
    checkedAt,
    windows: [7, 30, 90].map((days) => ({
      days,
      percent: ratio(lastDays(days)),
    })),
    features: history.checks.map((check) => ({
      id: check.id,
      name: check.name,
      up: history.latest[check.id]?.up ?? false,
      uptime: ratio(buckets(check.id, 90)),
      averageMs: average(buckets(check.id, 30)),
      recent: history.recent.map((sample) => ({
        at: new Date(sample.at),
        ms: sample.ms[check.id] ?? null,
      })),
    })),
    days: dates.map((date) => {
      const day = byDate.get(date);
      return {
        date,
        percent: day ? ratio([day]) : null,
        features: history.checks.map((check) => {
          const bucket = day?.byCheck[check.id];
          return {
            id: check.id,
            name: check.name,
            percent: bucket ? ratio([bucket]) : null,
            averageMs: bucket ? average([bucket]) : null,
          };
        }),
        incidents: history.incidents
          .filter(
            (incident) => chapterDate.format(new Date(incident.at)) === date,
          )
          .map((incident) => ({
            at: new Date(incident.at),
            name: names.get(incident.id) ?? incident.id,
            detail: incident.detail,
          })),
      };
    }),
  };
}
