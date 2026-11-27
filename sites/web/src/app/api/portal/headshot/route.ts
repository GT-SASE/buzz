import { eq } from "drizzle-orm";
import { revalidatePath, revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";

import {
  boardFromResults,
  HEADSHOT_UPLOAD_LIMIT,
  isUndefinedTable,
  takeToken,
} from "@buzz/api";
import { auth } from "@buzz/auth";
import { boardPhotos, db } from "@buzz/db";
import { BOARD_TAG } from "~/data/board";
import { processHeadshot } from "~/lib/headshot";
import { jsonError, sameOriginRejection } from "~/app/api/_lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A new photo or a takedown changes the public board, so drop its cache. */
function refreshBoard() {
  revalidateTag(BOARD_TAG, "max");
  revalidatePath("/board");
  revalidatePath("/");
}

/** The signed-in member, if they hold a seat on the current board. */
async function seatHolder(
  req: NextRequest,
): Promise<{ userId: string } | { response: Response }> {
  const rejected = sameOriginRejection(req);
  if (rejected) return { response: rejected };

  const session = await auth();
  if (!session?.user) {
    return { response: jsonError("Sign in to add a photo.", 401) };
  }
  let seats;
  try {
    seats = (await boardFromResults(db)) ?? [];
  } catch (error) {
    if (isUndefinedTable(error)) {
      return { response: jsonError("Board photos are not ready yet.", 503) };
    }
    throw error;
  }
  if (!seats.some((seat) => seat.userId === session.user.id)) {
    return {
      response: jsonError(
        "Only members on the current board can add a board photo.",
        403,
      ),
    };
  }
  return { userId: session.user.id };
}

/** Upload or replace your own photo. */
export async function POST(req: NextRequest) {
  const holder = await seatHolder(req);
  if ("response" in holder) return holder.response;

  if (
    !(await takeToken(
      db,
      `headshot-upload:${holder.userId}`,
      HEADSHOT_UPLOAD_LIMIT,
    ))
  ) {
    return jsonError("Too many requests. Try again shortly.", 429);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("Choose an image to upload.", 400);
  }
  const processed = await processHeadshot(
    new Uint8Array(await file.arrayBuffer()),
  );
  if ("error" in processed) return jsonError(processed.error, 400);

  const values = {
    userId: holder.userId,
    contentType: "image/webp",
    byteSize: processed.webp.byteLength,
    bytes: processed.webp.toString("base64"),
    etag: processed.etag,
    updatedAt: new Date(),
  };
  await db
    .insert(boardPhotos)
    .values(values)
    .onConflictDoUpdate({ target: boardPhotos.userId, set: values });

  refreshBoard();
  return Response.json({ version: processed.etag });
}

/** Remove your own photo. */
export async function DELETE(req: NextRequest) {
  const holder = await seatHolder(req);
  if ("response" in holder) return holder.response;

  await db.delete(boardPhotos).where(eq(boardPhotos.userId, holder.userId));
  refreshBoard();
  return Response.json({ removed: true });
}
