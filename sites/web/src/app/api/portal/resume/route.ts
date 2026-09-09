import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import {
  decodeResumeBytes,
  parseResumeUpload,
  resumeDownloadHeaders,
  RESUME_UPLOAD_LIMIT,
  takeToken,
  isUndefinedTable,
} from "@buzz/api";
import { auth } from "@buzz/auth";
import { db, resumes } from "@buzz/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameOriginRejection(req: NextRequest): Response | null {
  if (req.method === "GET" || req.method === "HEAD") return null;

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

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return jsonError("Sign in to download your resume.", 401);
  }

  let row;
  try {
    row = await db.query.resumes.findFirst({
      where: eq(resumes.userId, session.user.id),
    });
  } catch (error) {
    if (isUndefinedTable(error)) {
      return jsonError("Resume not found.", 404);
    }
    throw error;
  }

  if (!row) {
    return jsonError("Resume not found.", 404);
  }

  return new Response(decodeResumeBytes(row.fileBytes), {
    headers: resumeDownloadHeaders(row.fileName),
  });
}

export async function POST(req: NextRequest) {
  const rejected = sameOriginRejection(req);
  if (rejected) return rejected;

  const session = await auth();
  if (!session?.user) {
    return jsonError("Sign in to upload a resume.", 401);
  }

  if (!takeToken(`resume-upload:${session.user.id}`, RESUME_UPLOAD_LIMIT)) {
    return jsonError("Too many requests. Try again shortly.", 429);
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("Choose a PDF to upload.", 400);
  }

  const parsed = parseResumeUpload({
    name: file.name,
    type: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
  });
  if ("error" in parsed) {
    return jsonError(parsed.error, 400);
  }

  const now = new Date();
  try {
    await db
      .insert(resumes)
      .values({
        userId: session.user.id,
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        byteSize: parsed.byteSize,
        fileBytes: parsed.fileBytes,
        uploadedAt: now,
      })
      .onConflictDoUpdate({
        target: resumes.userId,
        set: {
          fileName: parsed.fileName,
          mimeType: parsed.mimeType,
          byteSize: parsed.byteSize,
          fileBytes: parsed.fileBytes,
          uploadedAt: now,
        },
      });
  } catch (error) {
    if (isUndefinedTable(error)) {
      return jsonError("Resume storage is not ready yet.", 503);
    }
    throw error;
  }

  return Response.json({
    fileName: parsed.fileName,
    byteSize: parsed.byteSize,
    uploadedAt: now.toISOString(),
  });
}
