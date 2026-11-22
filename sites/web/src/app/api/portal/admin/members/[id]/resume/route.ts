import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

import {
  decodeResumeBytes,
  isUndefinedTable,
  recordAudit,
  resumeDownloadHeaders,
} from "@buzz/api";
import { auth } from "@buzz/auth";
import { db, isOfficerRole, resumes, users } from "@buzz/db";

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
  if (!isOfficerRole(session.user.role)) {
    return jsonError("Officer access required.", 403);
  }

  const { id } = await params;
  if (!id) {
    return jsonError("Resume not found.", 404);
  }

  let row;
  try {
    [row] = await db
      .select({
        userId: resumes.userId,
        fileName: resumes.fileName,
        byteSize: resumes.byteSize,
        fileBytes: resumes.fileBytes,
        email: users.email,
      })
      .from(resumes)
      .innerJoin(users, eq(users.id, resumes.userId))
      .where(eq(resumes.userId, id));
  } catch (error) {
    if (isUndefinedTable(error)) {
      return jsonError("Resume not found.", 404);
    }
    throw error;
  }

  if (!row) {
    return jsonError("Resume not found.", 404);
  }

  // Before the bytes leave: a download that cannot be logged is not served.
  await recordAudit(db, {
    actorId: session.user.id,
    action: "resume.download",
    targetType: "member",
    targetId: row.userId,
    targetLabel: row.email,
    after: { fileName: row.fileName, bytes: row.byteSize },
  });

  return new Response(decodeResumeBytes(row.fileBytes), {
    headers: resumeDownloadHeaders(row.fileName),
  });
}
