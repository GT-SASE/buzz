"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { PAGES_TAG } from "~/data/pages";
import { isValidPageSlug } from "@buzz/api/page-slug";

/** Drop the cached pages so an edit, publish, or delete shows on /{slug} and in the sitemap at once. */
export async function revalidatePages(slugs: string[]) {
  await requireOfficer("/portal/admin/pages");
  revalidateTag(PAGES_TAG, "max");
  revalidatePath("/sitemap.xml");
  for (const slug of new Set(slugs)) {
    if (isValidPageSlug(slug)) revalidatePath(`/${slug}`);
  }
}
