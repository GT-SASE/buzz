import { TRPCError } from "@trpc/server";
import { desc, eq, ne } from "drizzle-orm";
import { z } from "zod";

import { notFound } from "../errors";
import { ANNOUNCEMENT_SLUG, pageSlugProblem } from "../page-slug";
import { isUniqueViolation } from "../pg-errors";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { pages } from "@buzz/db";

const pageSlugSchema = z.string().superRefine((slug, ctx) => {
  const problem = pageSlugProblem(slug);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const pageInput = z.object({
  slug: pageSlugSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300),
  body: z.string().max(100_000),
  published: z.boolean(),
});

function slugTaken(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: "Another page already uses that URL.",
  });
}

export const pageRouter = createTRPCRouter({
  list: adminProcedure.query(({ ctx }) =>
    ctx.db
      .select({
        id: pages.id,
        slug: pages.slug,
        title: pages.title,
        published: pages.published,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      // The site banner is a row of this table, but it has its own editor.
      .where(ne(pages.slug, ANNOUNCEMENT_SLUG))
      .orderBy(desc(pages.updatedAt)),
  ),

  byId: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const [row] = await ctx.db
        .select()
        .from(pages)
        .where(eq(pages.id, input.id));
      return row ?? notFound("Page");
    }),

  create: adminProcedure.input(pageInput).mutation(async ({ ctx, input }) => {
    try {
      const [created] = await ctx.db
        .insert(pages)
        .values({ ...input, createdById: ctx.session.user.id })
        .returning();
      return created!;
    } catch (error) {
      if (isUniqueViolation(error)) slugTaken();
      throw error;
    }
  }),

  update: adminProcedure
    .input(pageInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      try {
        const [before] = await ctx.db
          .select({ slug: pages.slug })
          .from(pages)
          .where(eq(pages.id, id));
        const [updated] = await ctx.db
          .update(pages)
          .set(fields)
          .where(eq(pages.id, id))
          .returning();
        if (!before || !updated) return notFound("Page");
        return { page: updated, previousSlug: before.slug };
      } catch (error) {
        if (isUniqueViolation(error)) slugTaken();
        throw error;
      }
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const [deleted] = await ctx.db
        .delete(pages)
        .where(eq(pages.id, input.id))
        .returning({ id: pages.id, slug: pages.slug });
      return deleted ?? notFound("Page");
    }),
});
