import { eq } from "drizzle-orm";

import { db, pageImages } from "@buzz/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An image an officer uploaded for a page. Rows are never edited, so the id
 * is the version: the URL can be cached for a year, and the ETag answers a
 * revalidation with a 304. Not under `/api`, so nothing that probes the API
 * touches it.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let row;
  try {
    [row] = await db
      .select({
        bytes: pageImages.bytes,
        etag: pageImages.etag,
        contentType: pageImages.contentType,
      })
      .from(pageImages)
      .where(eq(pageImages.id, id));
  } catch {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!row) {
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

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
