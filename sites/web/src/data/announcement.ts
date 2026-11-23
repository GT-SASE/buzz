import "server-only";

import { eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { ANNOUNCEMENT_SLUG } from "@buzz/api/page-slug";
import { db, pages } from "@buzz/db";
import { announcementFromRow } from "~/lib/announcement";

export const ANNOUNCEMENT_TAG = "announcement";

// Throws on a database error: unstable_cache does not store a throw, so one
// transient failure is not served for the whole revalidate window.
async function fetchAnnouncement() {
  if (!process.env.DATABASE_URL) return null;
  const [row] = await db
    .select({
      title: pages.title,
      description: pages.description,
      body: pages.body,
      published: pages.published,
      updatedAt: pages.updatedAt,
    })
    .from(pages)
    .where(eq(pages.slug, ANNOUNCEMENT_SLUG));
  return row ? announcementFromRow(row) : null;
}

// Same window as the page builder's cache; an officer's save drops it at once
// through `revalidateAnnouncement`, this is the ceiling if that call is missed.
const loadAnnouncement = unstable_cache(
  fetchAnnouncement,
  [ANNOUNCEMENT_TAG, "v1"],
  {
    tags: [ANNOUNCEMENT_TAG],
    revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
  },
);

/** The banner to show on every public page, or null for none or on a database error. */
export async function getAnnouncement() {
  try {
    return await loadAnnouncement();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "announcement.load",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}
