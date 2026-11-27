import "server-only";

import { and, asc, eq, ne } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { pageRedirectTarget } from "@buzz/api/page-redirect";
import { ANNOUNCEMENT_SLUG, isValidPageSlug } from "@buzz/api/page-slug";
import { db, pages } from "@buzz/db";
import { logLoadError } from "~/lib/log-error";

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
    // The site banner is a published row too, but not a page.
    .where(and(eq(pages.published, true), ne(pages.slug, ANNOUNCEMENT_SLUG)))
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
    logLoadError("pages.list", error);
    return [];
  }
}

/** A published page's content, or null for a draft, a missing slug, or no database. */
export async function getPublishedPage(slug: string) {
  if (!isValidPageSlug(slug)) return null;
  try {
    return await loadPage(slug);
  } catch (error) {
    logLoadError("pages.load", error);
    return null;
  }
}

// Throws on any database error, including a missing table before migration
// 0019: unstable_cache does not store a throw, so "no redirects yet" is never
// remembered past the migration.
const loadRedirect = unstable_cache(
  (slug: string) => pageRedirectTarget(db, slug),
  [PAGES_TAG, "redirect", "v1"],
  {
    tags: [PAGES_TAG],
    revalidate: process.env.NODE_ENV === "production" ? 3600 : 60,
  },
);

/**
 * The current address of a page that used to live at `slug`, or null (no
 * redirect, a live page owns the slug, no database, or the redirect table is
 * not there yet).
 */
export async function getPageRedirect(slug: string) {
  if (!process.env.DATABASE_URL || !isValidPageSlug(slug)) return null;
  try {
    return await loadRedirect(slug);
  } catch (error) {
    logLoadError("pages.redirect", error);
    return null;
  }
}
