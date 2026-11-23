import { eq } from "drizzle-orm";

import { boardFromResults } from "@buzz/api";
import { boardPhotos, db } from "@buzz/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = new Response(null, {
  status: 404,
  headers: { "Cache-Control": "public, max-age=60" },
});

/**
 * A board member's headshot, for the public board page. Served only for
 * someone who holds a seat on the current board; anyone else is a 404, so an
 * old upload is not reachable by guessing an id. The URL carries the image's
 * hash (`?v=`), so a browser or the CDN can keep it for a year, and the ETag
 * answers revalidation with a 304. Not under `/api`, so nothing that probes
 * the API touches it.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let row;
  let seated;
  try {
    [[row], seated] = await Promise.all([
      db
        .select({
          bytes: boardPhotos.bytes,
          etag: boardPhotos.etag,
          contentType: boardPhotos.contentType,
        })
        .from(boardPhotos)
        .where(eq(boardPhotos.userId, id)),
      boardFromResults(db),
    ]);
  } catch {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!row || !seated?.some((seat) => seat.userId === id)) return NOT_FOUND;

  const etag = `"${row.etag}"`;
  const headers = {
    ETag: etag,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": row.contentType,
    "Content-Security-Policy": "default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  };
  const sent = req.headers.get("if-none-match");
  if (sent?.split(",").some((value) => value.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(Buffer.from(row.bytes, "base64"), { headers });
}
