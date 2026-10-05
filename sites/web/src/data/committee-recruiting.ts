import "server-only";

import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { semester, semesterLabel } from "@buzz/api";
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

async function fetchCycle(
  id: string,
): Promise<{ closesAt: string; committees: string[] } | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const [row] = await db
      .select({
        closesAt: committeeCycles.closesAt,
        committees: committeeCycles.committees,
      })
      .from(committeeCycles)
      .where(eq(committeeCycles.id, id));
    return row
      ? { closesAt: row.closesAt.toISOString(), committees: row.committees }
      : null;
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
}

const loadCycle = unstable_cache(fetchCycle, [COMMITTEE_RECRUITING_TAG, "v2"], {
  tags: [COMMITTEE_RECRUITING_TAG],
  revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
});

/** "Events", "Events and Website Team", "Events, Marketing, and Treasury". */
export function listNames(names: readonly string[]) {
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

/**
 * This semester's committee recruiting, or null when officers have not
 * opened it. `open` is computed per request, so a cached row still closes
 * on time.
 */
export async function getCommitteeRecruiting(now = new Date()) {
  const id = semester(now);
  const cycle = await loadCycle(id);
  if (!cycle) return null;
  const closesAt = new Date(cycle.closesAt);
  const open = committees.filter((committee) =>
    cycle.committees.includes(committee.id),
  );
  return {
    id,
    label: semesterLabel(id),
    closesAt,
    closesLabel: closesFormat.format(closesAt),
    open: now.getTime() < closesAt.getTime(),
    committees: open,
    names: open.map((committee) => committee.title.replace(/ Committee$/, "")),
  };
}
