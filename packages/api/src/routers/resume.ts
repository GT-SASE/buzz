import { eq } from "drizzle-orm";

import { notFound } from "../errors";
import { isUndefinedTable } from "../pg-errors";
import { assertRateLimit, RESUME_UPLOAD_LIMIT } from "../rate-limit";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { resumes } from "@buzz/db";

const metadataSelect = {
  fileName: resumes.fileName,
  mimeType: resumes.mimeType,
  byteSize: resumes.byteSize,
  uploadedAt: resumes.uploadedAt,
} as const;

export const resumeRouter = createTRPCRouter({
  mine: protectedProcedure.query(async ({ ctx }) => {
    try {
      const row = await ctx.db.query.resumes.findFirst({
        where: eq(resumes.userId, ctx.session.user.id),
        columns: {
          fileName: true,
          mimeType: true,
          byteSize: true,
          uploadedAt: true,
        },
      });
      return row ?? null;
    } catch (error) {
      if (isUndefinedTable(error)) return null;
      throw error;
    }
  }),

  remove: protectedProcedure.mutation(async ({ ctx }) => {
    assertRateLimit(
      `resume-upload:${ctx.session.user.id}`,
      RESUME_UPLOAD_LIMIT,
    );

    const [deleted] = await ctx.db
      .delete(resumes)
      .where(eq(resumes.userId, ctx.session.user.id))
      .returning(metadataSelect);

    if (!deleted) {
      notFound("Resume");
    }
    return deleted;
  }),
});
