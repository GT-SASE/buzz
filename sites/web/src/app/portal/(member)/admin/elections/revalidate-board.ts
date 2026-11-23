"use server";

import { revalidatePath, revalidateTag } from "next/cache";

import { requireOfficer } from "~/app/portal/_lib/session";
import { BOARD_TAG } from "~/data/board";

/** Publishing results changes who the public board lists, so drop its cache. */
export async function revalidateBoard() {
  await requireOfficer("/portal/admin");
  revalidateTag(BOARD_TAG, "max");
  revalidatePath("/board");
  revalidatePath("/");
}
