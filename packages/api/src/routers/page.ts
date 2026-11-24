import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNotNull, isNull, max, ne } from "drizzle-orm";
import { z } from "zod";

import { recordAudit } from "../audit";
import { notFound } from "../errors";
import { ANNOUNCEMENT_SLUG, pageSlugProblem } from "../page-slug";
import { isUndefinedTable, isUniqueViolation } from "../pg-errors";
import { adminProcedure, createTRPCRouter } from "../trpc";
import {
  pageRedirects,
  pages,
  pageVersions,
  users,
  type db as Db,
} from "@buzz/db";

const pageSlugSchema = z.string().superRefine((slug, ctx) => {
  const problem = pageSlugProblem(slug);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

const draftInput = z.object({
  slug: pageSlugSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(300),
  body: z.string().max(100_000),
});

const idInput = z.object({ id: z.string().min(1) });

function slugTaken(): never {
  throw new TRPCError({
    code: "CONFLICT",
    message: "Another page already uses that URL.",
  });
}

function notReady(): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "Page drafts are not ready yet. Try again after the next deploy.",
  });
}

/** Run a version-table query; a database that has not been migrated yet is a clear error, not a 500. */
async function needsVersions<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUndefinedTable(error)) notReady();
    throw error;
  }
}

type Tx = Parameters<Parameters<typeof Db.transaction>[0]>[0];

async function lockPage(tx: Tx, id: string) {
  const [page] = await tx
    .select()
    .from(pages)
    .where(and(eq(pages.id, id), ne(pages.slug, ANNOUNCEMENT_SLUG)))
    .for("update");
  return page ?? notFound("Page");
}

async function openDraft(tx: Tx, pageId: string) {
  const [draft] = await tx
    .select()
    .from(pageVersions)
    .where(
      and(
        eq(pageVersions.pageId, pageId),
        isNull(pageVersions.publishedAt),
        isNull(pageVersions.supersededAt),
      ),
    );
  return draft ?? null;
}

async function nextNumber(tx: Tx, pageId: string) {
  const [row] = await tx
    .select({ top: max(pageVersions.number) })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId));
  return (row?.top ?? 0) + 1;
}

async function everPublished(tx: Tx, page: { id: string; published: boolean }) {
  if (page.published) return true;
  const [row] = await tx
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .where(
      and(
        eq(pageVersions.pageId, page.id),
        isNotNull(pageVersions.publishedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Every old address of the page, whose cached redirect or 404 changes with it. */
async function redirectSlugs(tx: Tx, pageId: string) {
  const rows = await tx
    .select({ slug: pageRedirects.fromSlug })
    .from(pageRedirects)
    .where(eq(pageRedirects.pageId, pageId));
  return rows.map((row) => row.slug);
}

export const pageRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
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
      .orderBy(desc(pages.updatedAt));

    let drafts: { pageId: string; title: string; updatedAt: Date }[] = [];
    try {
      drafts = await ctx.db
        .select({
          pageId: pageVersions.pageId,
          title: pageVersions.title,
          updatedAt: pageVersions.updatedAt,
        })
        .from(pageVersions)
        .where(
          and(
            isNull(pageVersions.publishedAt),
            isNull(pageVersions.supersededAt),
          ),
        );
    } catch (error) {
      // Before the migration there are no drafts: every page is what it was.
      if (!isUndefinedTable(error)) throw error;
    }
    const draftOf = new Map(drafts.map((draft) => [draft.pageId, draft]));
    return rows
      .map((row) => {
        const draft = draftOf.get(row.id);
        return {
          ...row,
          // The title an officer is working on, which a published page's live title may lag.
          title: draft?.title ?? row.title,
          hasDraft: draft !== undefined,
          updatedAt:
            draft && draft.updatedAt > row.updatedAt
              ? draft.updatedAt
              : row.updatedAt,
        };
      })
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }),

  /** The page as it is live, plus the draft the editor works on (the live text when there is none). */
  byId: adminProcedure.input(idInput).query(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .select()
      .from(pages)
      .where(and(eq(pages.id, input.id), ne(pages.slug, ANNOUNCEMENT_SLUG)));
    if (!row) return notFound("Page");

    let draft = null;
    let latest = 0;
    try {
      [draft] = await ctx.db
        .select()
        .from(pageVersions)
        .where(
          and(
            eq(pageVersions.pageId, row.id),
            isNull(pageVersions.publishedAt),
            isNull(pageVersions.supersededAt),
          ),
        );
      const [top] = await ctx.db
        .select({ top: max(pageVersions.number) })
        .from(pageVersions)
        .where(eq(pageVersions.pageId, row.id));
      latest = top?.top ?? 0;
    } catch (error) {
      if (!isUndefinedTable(error)) throw error;
    }

    const source = draft ?? row;
    return {
      id: row.id,
      published: row.published,
      /** The address it is live at (or was, when it is a draft again). */
      liveSlug: row.slug,
      liveTitle: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      hasDraft: draft != null,
      /** Highest version number; 0 before the migration. */
      latestVersion: latest,
      draft: {
        number: draft?.number ?? latest,
        slug: source.slug,
        title: source.title,
        description: source.description,
        body: source.body,
        updatedAt: draft?.updatedAt ?? row.updatedAt,
      },
    };
  }),

  versions: adminProcedure.input(idInput).query(async ({ ctx, input }) => {
    const rows = await needsVersions(() =>
      ctx.db
        .select({
          number: pageVersions.number,
          slug: pageVersions.slug,
          title: pageVersions.title,
          restoredFrom: pageVersions.restoredFrom,
          createdAt: pageVersions.createdAt,
          updatedAt: pageVersions.updatedAt,
          publishedAt: pageVersions.publishedAt,
          supersededAt: pageVersions.supersededAt,
          authorName: users.name,
          authorEmail: users.email,
        })
        .from(pageVersions)
        .leftJoin(users, eq(users.id, pageVersions.createdById))
        .where(eq(pageVersions.pageId, input.id))
        .orderBy(desc(pageVersions.number)),
    );
    const [page] = await ctx.db
      .select({ published: pages.published })
      .from(pages)
      .where(eq(pages.id, input.id));
    // The live version is the newest one that was published, while the page is up.
    const live = page?.published
      ? rows
          .filter((row) => row.publishedAt)
          .sort(
            (a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime(),
          )[0]?.number
      : undefined;
    return rows.map((row) => ({
      ...row,
      state:
        row.number === live
          ? ("live" as const)
          : row.publishedAt
            ? ("published" as const)
            : row.supersededAt
              ? ("replaced" as const)
              : ("draft" as const),
    }));
  }),

  /** A page starts as a draft: it is not on the public site until `publish`. */
  create: adminProcedure.input(draftInput).mutation(async ({ ctx, input }) => {
    try {
      const created = await needsVersions(() =>
        ctx.db.transaction(async (tx) => {
          const [page] = await tx
            .insert(pages)
            .values({
              ...input,
              published: false,
              createdById: ctx.session.user.id,
            })
            .returning();
          await tx.insert(pageVersions).values({
            pageId: page!.id,
            number: 1,
            ...input,
            createdById: ctx.session.user.id,
          });
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "page.create",
            targetType: "page",
            targetId: page!.id,
            targetLabel: input.title,
            after: { slug: input.slug },
          });
          return page!;
        }),
      );
      return created;
    } catch (error) {
      if (isUniqueViolation(error)) slugTaken();
      throw error;
    }
  }),

  /**
   * Save the text without publishing. Edits the open draft in place, or opens
   * the next version when there is none (right after a publish or a restore).
   * Not audited: nothing public changes until `publish`.
   */
  saveDraft: adminProcedure
    .input(draftInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      try {
        return await needsVersions(() =>
          ctx.db.transaction(async (tx) => {
            const page = await lockPage(tx, id);
            const [taken] = await tx
              .select({ id: pages.id })
              .from(pages)
              .where(and(eq(pages.slug, fields.slug), ne(pages.id, id)));
            if (taken) slugTaken();

            const draft = await openDraft(tx, id);
            const now = new Date();
            let number: number;
            if (draft) {
              number = draft.number;
              await tx
                .update(pageVersions)
                .set({
                  ...fields,
                  updatedAt: now,
                  createdById: ctx.session.user.id,
                })
                .where(eq(pageVersions.id, draft.id));
            } else {
              number = await nextNumber(tx, id);
              await tx.insert(pageVersions).values({
                pageId: id,
                number,
                ...fields,
                createdById: ctx.session.user.id,
              });
            }
            // A page that was never live is only its draft: keep its row in step so the
            // address it is working toward is the one it holds.
            if (!(await everPublished(tx, page))) {
              await tx.update(pages).set(fields).where(eq(pages.id, id));
            }
            return { number };
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error)) slugTaken();
        throw error;
      }
    }),

  /**
   * Make the draft the live page. If the page was live at another address, the
   * old address now redirects here; a redirect from the new address is dropped,
   * so a redirect never hides a live page.
   */
  publish: adminProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    let result: { slugs: string[]; slug: string; version: number };
    try {
      result = await needsVersions(() =>
        ctx.db.transaction(async (tx) => {
          const page = await lockPage(tx, input.id);
          const draft = await openDraft(tx, input.id);
          if (!draft && page.published) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "There is nothing new to publish.",
            });
          }

          const content = draft ?? page;
          const problem = pageSlugProblem(content.slug);
          if (problem) {
            throw new TRPCError({ code: "BAD_REQUEST", message: problem });
          }
          const [taken] = await tx
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.slug, content.slug), ne(pages.id, page.id)));
          if (taken) slugTaken();

          const wasLive = await everPublished(tx, page);
          const moved = page.slug !== content.slug;
          if (moved && wasLive && pageSlugProblem(page.slug) === null) {
            await tx
              .insert(pageRedirects)
              .values({ fromSlug: page.slug, pageId: page.id })
              .onConflictDoUpdate({
                target: pageRedirects.fromSlug,
                set: { pageId: page.id },
              });
          }
          // The address now belongs to a live page, so nothing may redirect away from it.
          await tx
            .delete(pageRedirects)
            .where(eq(pageRedirects.fromSlug, content.slug));

          const now = new Date();
          await tx
            .update(pages)
            .set({
              slug: content.slug,
              title: content.title,
              description: content.description,
              body: content.body,
              published: true,
              updatedAt: now,
            })
            .where(eq(pages.id, page.id));

          let version: number;
          if (draft) {
            version = draft.number;
            await tx
              .update(pageVersions)
              .set({ publishedAt: now, updatedAt: now })
              .where(eq(pageVersions.id, draft.id));
          } else {
            // Republishing a page taken down: its newest version goes live again.
            const [newest] = await tx
              .select({ number: pageVersions.number })
              .from(pageVersions)
              .where(eq(pageVersions.pageId, page.id))
              .orderBy(desc(pageVersions.number))
              .limit(1);
            version = newest?.number ?? 0;
          }

          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "page.publish",
            targetType: "page",
            targetId: page.id,
            targetLabel: content.title,
            before: { slug: page.slug, published: page.published },
            after: { slug: content.slug, version },
          });
          return {
            slugs: [
              page.slug,
              content.slug,
              ...(await redirectSlugs(tx, page.id)),
            ],
            slug: content.slug,
            version,
          };
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) slugTaken();
      throw error;
    }
    return {
      slug: result.slug,
      version: result.version,
      revalidate: result.slugs,
    };
  }),

  /** Take the page off the public site. The text and history stay. */
  unpublish: adminProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const slug = await ctx.db.transaction(async (tx) => {
      const page = await lockPage(tx, input.id);
      if (!page.published) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "This page is already a draft.",
        });
      }
      await tx
        .update(pages)
        .set({ published: false })
        .where(eq(pages.id, page.id));
      await recordAudit(tx, {
        actorId: ctx.session.user.id,
        action: "page.unpublish",
        targetType: "page",
        targetId: page.id,
        targetLabel: page.title,
        before: { slug: page.slug, published: true },
        after: { published: false },
      });
      return [page.slug, ...(await redirectSlugs(tx, page.id))];
    });
    return { slug: slug[0]!, revalidate: slug };
  }),

  /**
   * Copy an old version's text into a new draft version. It does not touch the
   * live page; publish when it reads right. An unpublished draft already open
   * is kept in the history as replaced.
   */
  restore: adminProcedure
    .input(z.object({ id: z.string().min(1), number: z.number().int().min(1) }))
    .mutation(async ({ ctx, input }) =>
      needsVersions(() =>
        ctx.db.transaction(async (tx) => {
          const page = await lockPage(tx, input.id);
          const [source] = await tx
            .select()
            .from(pageVersions)
            .where(
              and(
                eq(pageVersions.pageId, page.id),
                eq(pageVersions.number, input.number),
              ),
            );
          if (!source) return notFound("Version");

          const now = new Date();
          const draft = await openDraft(tx, page.id);
          if (draft) {
            await tx
              .update(pageVersions)
              .set({ supersededAt: now })
              .where(eq(pageVersions.id, draft.id));
          }
          const number = await nextNumber(tx, page.id);
          await tx.insert(pageVersions).values({
            pageId: page.id,
            number,
            slug: source.slug,
            title: source.title,
            description: source.description,
            body: source.body,
            restoredFrom: source.number,
            createdById: ctx.session.user.id,
          });
          if (!(await everPublished(tx, page))) {
            await tx
              .update(pages)
              .set({
                slug: source.slug,
                title: source.title,
                description: source.description,
                body: source.body,
              })
              .where(eq(pages.id, page.id));
          }
          await recordAudit(tx, {
            actorId: ctx.session.user.id,
            action: "page.restore",
            targetType: "page",
            targetId: page.id,
            targetLabel: source.title,
            after: { restoredFrom: source.number, version: number },
          });
          return { number };
        }),
      ),
    ),

  delete: adminProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db.transaction(async (tx) => {
      const page = await lockPage(tx, input.id);
      const old = await redirectSlugs(tx, page.id);
      await tx.delete(pages).where(eq(pages.id, page.id));
      await recordAudit(tx, {
        actorId: ctx.session.user.id,
        action: "page.delete",
        targetType: "page",
        targetId: page.id,
        targetLabel: page.title,
        before: { slug: page.slug, published: page.published },
      });
      return { id: page.id, slug: page.slug, old };
    });
    return { ...deleted, revalidate: [deleted.slug, ...deleted.old] };
  }),
});
