import "server-only";

import { revalidatePath, revalidateTag } from "next/cache";

import { PAGES_TAG } from "~/data/pages";
import { isValidPageSlug } from "@buzz/api/page-slug";

/**
 * Drop the cached public pages so a publish, a take-down, a rename or a delete
 * shows on /{slug} and in the sitemap at once. Handed to the tRPC context, so
 * the page mutations call it themselves after they commit.
 */
export function revalidatePages(slugs: string[]) {
  // Expire at once, not stale-while-revalidate: the page the path drops would
  // otherwise be rebuilt from the stale cached row and stay stale for an hour.
  revalidateTag(PAGES_TAG, { expire: 0 });
  revalidatePath("/sitemap.xml");
  for (const slug of new Set(slugs)) {
    if (isValidPageSlug(slug)) revalidatePath(`/${slug}`);
  }
}
