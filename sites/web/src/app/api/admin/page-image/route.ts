import type { NextRequest } from "next/server";

import {
  isUndefinedTable,
  PAGE_IMAGE_UPLOAD_LIMIT,
  pageImageUrl,
  recordAudit,
  takeToken,
} from "@buzz/api";
import { auth } from "@buzz/auth";
import { db, isOfficerRole, pageImages } from "@buzz/db";
import { processPageImage } from "~/lib/page-image";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOriginRejection(req: NextRequest): Response | null {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return null;

  const origin = req.headers.get("origin");
  if (!origin) {
    if (!secFetchSite) return null;
    return Response.json({ error: "Origin required" }, { status: 403 });
  }
  if (origin !== req.nextUrl.origin) {
    return Response.json({ error: "Forbidden origin" }, { status: 403 });
  }
  return null;
}

const jsonError = (error: string, status: number) =>
  Response.json({ error }, { status });

/** An officer uploads an image for a page; the reply is the URL to put in Markdown. */
export async function POST(req: NextRequest) {
  const rejected = sameOriginRejection(req);
  if (rejected) return rejected;

  const session = await auth();
  if (!session?.user) return jsonError("Sign in to upload an image.", 401);
  if (!isOfficerRole(session.user.role)) {
    return jsonError("Only officers can upload page images.", 403);
  }
  const actorId = session.user.id;

  if (
    !(await takeToken(db, `page-image:${actorId}`, PAGE_IMAGE_UPLOAD_LIMIT))
  ) {
    return jsonError("Too many uploads. Try again shortly.", 429);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("Choose an image to upload.", 400);
  }
  const processed = await processPageImage(
    new Uint8Array(await file.arrayBuffer()),
  );
  if ("error" in processed) return jsonError(processed.error, 400);
  if (processed.height > 10_000) {
    return jsonError("That image is too tall. Crop it and try again.", 400);
  }

  try {
    const id = crypto.randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(pageImages).values({
        id,
        contentType: "image/webp",
        byteSize: processed.webp.byteLength,
        width: processed.width,
        height: processed.height,
        bytes: processed.webp.toString("base64"),
        etag: processed.etag,
        createdById: actorId,
      });
      await recordAudit(tx, {
        actorId,
        action: "page.upload_image",
        targetType: "page",
        targetId: id,
        targetLabel: file.name.slice(0, 120),
        after: {
          width: processed.width,
          height: processed.height,
          bytes: processed.webp.byteLength,
        },
      });
    });
    return Response.json({
      id,
      url: pageImageUrl(id),
      width: processed.width,
      height: processed.height,
    });
  } catch (error) {
    if (isUndefinedTable(error)) {
      return jsonError("Image uploads are not ready yet.", 503);
    }
    throw error;
  }
}
