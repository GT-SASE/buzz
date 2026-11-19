import "server-only";

import { and, eq } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { isValidPageSlug } from "@buzz/api/page-slug";
import { db, pages } from "@buzz/db";

export const PAGES_TAG = "pages";

async function fetchPage(slug: string) {
  if (!process.env.DATABASE_URL) return null;
  try {
    const [row] = await db
      .select({
        title: pages.title,
        description: pages.description,
        body: pages.body,
      })
      .from(pages)
      .where(and(eq(pages.slug, slug), eq(pages.published, true)));
    return row ?? null;
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

const loadPage = unstable_cache(fetchPage, [PAGES_TAG, "v1"], {
  tags: [PAGES_TAG],
  revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
});

/** A published page's content, or null for a draft, a missing slug, or no database. */
export function getPublishedPage(slug: string) {
  return isValidPageSlug(slug) ? loadPage(slug) : Promise.resolve(null);
}
