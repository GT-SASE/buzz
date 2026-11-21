import "server-only";

import { desc } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { currentCommitteeCycle, semesterLabel } from "@buzz/api";
import { committeeCycles, db } from "@buzz/db";
import { committees } from "~/data/committees";

export const COMMITTEE_RECRUITING_TAG = "committee-recruiting";

const closesFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
});

// Throws on a database error: unstable_cache does not store a throw, so one
// transient failure is not served for the whole revalidate window.
//
// The newest few cycles, not one looked up by `semester(now)`: which of them
// is current depends on the clock, and is decided per request below.
async function fetchRecentCycles() {
  if (!process.env.DATABASE_URL) return [];
  const rows = await db
    .select({
      id: committeeCycles.id,
      createdAt: committeeCycles.createdAt,
      closesAt: committeeCycles.closesAt,
      committees: committeeCycles.committees,
    })
    .from(committeeCycles)
    .orderBy(desc(committeeCycles.createdAt))
    .limit(4);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    closesAt: row.closesAt.toISOString(),
    committees: row.committees,
  }));
}

const loadRecentCycles = unstable_cache(
  fetchRecentCycles,
  [COMMITTEE_RECRUITING_TAG, "v3"],
  {
    tags: [COMMITTEE_RECRUITING_TAG],
    revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
  },
);

/** "Events", "Events and Website Team", "Events, Marketing, and Treasury". */
export function listNames(names: readonly string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * The current committee recruiting (see `currentCommitteeCycle`), or null when
 * officers have not opened it. `open` is computed per request, so a cached row
 * still closes on time.
 */
export async function getCommitteeRecruiting(now = new Date()) {
  let rows: Awaited<ReturnType<typeof fetchRecentCycles>>;
  try {
    rows = await loadRecentCycles();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "committee.recruiting",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
  const cycle = currentCommitteeCycle(
    rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt),
      closesAt: new Date(row.closesAt),
    })),
    now,
  );
  if (!cycle) return null;
  const offered = new Set(cycle.committees);
  const open = committees.filter((committee) => offered.has(committee.id));
  return {
    id: cycle.id,
    label: semesterLabel(cycle.id),
    closesAt: cycle.closesAt,
    closesLabel: closesFormat.format(cycle.closesAt),
    open: now.getTime() < cycle.closesAt.getTime(),
    committees: open,
    names: open.map((committee) => committee.title.replace(/ Committee$/, "")),
  };
}
