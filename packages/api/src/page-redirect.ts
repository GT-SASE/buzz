import { and, eq, ne } from "drizzle-orm";

import { pageSlugProblem } from "./page-slug";
import { pageRedirects, pages, type db as Db } from "@buzz/db";

/**
 * Where an old page address should go, or null. A redirect row names the
 * page, not a target slug, so the answer is always the page's current slug
 * and a page renamed twice is still one hop. Nothing is returned when the
 * slug is unusable (reserved, malformed), when a live page owns it, or when
 * the page is a draft again.
 */
export async function pageRedirectTarget(
  db: typeof Db,
  slug: string,
): Promise<string | null> {
  if (pageSlugProblem(slug) !== null) return null;
  const [live] = await db
    .select({ id: pages.id })
    .from(pages)
    .where(and(eq(pages.slug, slug), eq(pages.published, true)));
  if (live) return null;
  const [row] = await db
    .select({ slug: pages.slug })
    .from(pageRedirects)
    .innerJoin(pages, eq(pages.id, pageRedirects.pageId))
    .where(
      and(
        eq(pageRedirects.fromSlug, slug),
        eq(pages.published, true),
        ne(pages.slug, slug),
      ),
    );
  if (!row || pageSlugProblem(row.slug) !== null) return null;
  return row.slug;
}
