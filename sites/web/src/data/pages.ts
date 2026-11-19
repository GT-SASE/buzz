import "server-only";

import { and, eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { isValidPageSlug } from "@buzz/api/page-slug";
import { db, pages } from "@buzz/db";

export const PAGES_TAG = "pages";

// Throws on a database error: unstable_cache does not store a throw, so one
// transient failure is not served for the whole revalidate window.
async function fetchPage(slug: string) {
  if (!process.env.DATABASE_URL) return null;
  const [row] = await db
    .select({
      title: pages.title,
      description: pages.description,
      body: pages.body,
    })
    .from(pages)
    .where(and(eq(pages.slug, slug), eq(pages.published, true)));
  return row ?? null;
}

const loadPage = unstable_cache(fetchPage, [PAGES_TAG, "v1"], {
  tags: [PAGES_TAG],
  revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
});

/** A published page's content, or null for a draft, a missing slug, or no database. */
export async function getPublishedPage(slug: string) {
  if (!isValidPageSlug(slug)) return null;
  try {
    return await loadPage(slug);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "pages.load",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}
