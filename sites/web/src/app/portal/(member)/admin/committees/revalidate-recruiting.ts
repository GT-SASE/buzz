"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { COMMITTEE_RECRUITING_TAG } from "~/data/committee-recruiting";

/** Drop the cached cycle so /join and the portal pick up an officer's change. */
export async function revalidateCommitteeRecruiting() {
  await requireOfficer("/portal/admin/committees");
  revalidateTag(COMMITTEE_RECRUITING_TAG, "max");
  revalidatePath("/join");
  revalidatePath("/website-team");
  revalidatePath("/portal");
}
