import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import {
  decodeResumeBytes,
  isUndefinedTable,
  resumeDownloadHeaders,
} from "@buzz/api";
import { auth } from "@buzz/auth";
import { db, resumes } from "@buzz/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return jsonError("Sign in required.", 401);
  }
  if (session.user.role !== "ADMIN") {
    return jsonError("Officer access required.", 403);
  }

  const { id } = await params;
  if (!id) {
    return jsonError("Resume not found.", 404);
  }

  let row;
  try {
    row = await db.query.resumes.findFirst({
      where: eq(resumes.userId, id),
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
