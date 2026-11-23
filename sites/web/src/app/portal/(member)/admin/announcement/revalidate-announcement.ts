"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { ANNOUNCEMENT_TAG } from "~/data/announcement";

/**
 * Drop the cached banner and every prerendered public page that carries it, so
 * an officer's save shows on the site on the next visit instead of at the end
 * of the cache window.
 */
export async function revalidateAnnouncement() {
  await requireOfficer("/portal/admin/announcement");
  revalidateTag(ANNOUNCEMENT_TAG, "max");
  revalidatePath("/", "layout");
}
