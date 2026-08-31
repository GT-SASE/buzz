"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { CHAPTER_EVENTS_TAG } from "~/data/chapter-events";

/** Drop the public calendar so / and /events pick up an officer's write. */
export async function revalidatePublicCalendar() {
  await requireOfficer("/portal/admin");
  revalidateTag(CHAPTER_EVENTS_TAG, "max");
  revalidatePath("/");
  revalidatePath("/events");
}
