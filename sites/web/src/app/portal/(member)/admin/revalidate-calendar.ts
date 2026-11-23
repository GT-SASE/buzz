"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { CHAPTER_EVENTS_TAG } from "~/data/chapter-events";

/**
 * Drop the public calendar so an officer's write shows everywhere it is read.
 * The tag reaches every page and route built from the calendar: each event's
 * page and share card, the month views, the feed and the sitemap. The paths
 * make the ones people look at right after saving, and the feed and sitemap,
 * refresh on the next request instead of serving one stale copy first.
 */
export async function revalidatePublicCalendar() {
  await requireOfficer("/portal/admin");
  revalidateTag(CHAPTER_EVENTS_TAG, "max");
  revalidatePath("/");
  revalidatePath("/events");
  revalidatePath("/events.ics");
  revalidatePath("/sitemap.xml");
}
