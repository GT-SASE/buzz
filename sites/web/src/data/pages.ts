import "server-only";

import { and, asc, eq } from "drizzle-orm";
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

// unstable_cache stores JSON, so the date travels as an ISO string.
async function fetchPublishedList() {
  if (!process.env.DATABASE_URL) return [];
  const rows = await db
    .select({ slug: pages.slug, updatedAt: pages.updatedAt })
    .from(pages)
    .where(eq(pages.published, true))
    .orderBy(asc(pages.slug));
  return rows.map((row) => ({
    slug: row.slug,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

const loadPublishedList = unstable_cache(
  fetchPublishedList,
  [PAGES_TAG, "list", "v1"],
  {
    tags: [PAGES_TAG],
    revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
  },
);

/** Every published page's slug and last edit, for the sitemap. Empty on a database error. */
export async function getPublishedPageList() {
  try {
    const rows = await loadPublishedList();
    return rows.map((row) => ({
      slug: row.slug,
      updatedAt: new Date(row.updatedAt),
    }));
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "pages.list",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return [];
  }
}

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
