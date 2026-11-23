import { eq } from "drizzle-orm";
import { z } from "zod";

import { ANNOUNCEMENT_SLUG } from "../page-slug";
import { adminProcedure, createTRPCRouter } from "../trpc";
import { pages } from "@buzz/db";

/**
 * The site-wide banner has no table. It is one row of `buzz_page` under the
 * reserved slug `ANNOUNCEMENT_SLUG`, read on the public site by
 * `sites/web/src/data/announcement.ts`, which repeats this column mapping:
 *
 *   title       the message
 *   description the link label ("" for no link)
 *   body        the link target ("" for no link)
 *   published   whether the banner is on
 *   updatedAt   the version a visitor's dismissal is keyed on
 */
export const ANNOUNCEMENT_MESSAGE_MAX = 200;
export const ANNOUNCEMENT_LABEL_MAX = 40;
export const ANNOUNCEMENT_HREF_MAX = 500;

/** A site path or an https URL. Anything else (`javascript:`, `//host`) is refused. */
export function announcementHrefProblem(href: string): string | null {
  if (href === "") return null;
  if (/\s/.test(href)) return "The link cannot contain spaces.";
  if (href.startsWith("/") && !href.startsWith("//")) return null;
  if (!href.startsWith("https://")) {
    return "Start the link with / for a page on this site or https:// for another site.";
  }
  try {
    new URL(href);
  } catch {
    return "That link is not a valid URL.";
  }
  return null;
}

const announcementInput = z
  .object({
    enabled: z.boolean(),
    message: z.string().trim().min(1).max(ANNOUNCEMENT_MESSAGE_MAX),
    linkLabel: z.string().trim().max(ANNOUNCEMENT_LABEL_MAX),
    linkHref: z.string().trim().max(ANNOUNCEMENT_HREF_MAX),
  })
  .superRefine((value, ctx) => {
    const problem = announcementHrefProblem(value.linkHref);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
    else if ((value.linkLabel === "") !== (value.linkHref === "")) {
      ctx.addIssue({
        code: "custom",
        message: "Give the link both a label and an address, or neither.",
      });
    }
  });

export const announcementRouter = createTRPCRouter({
  /** The saved banner, or an empty one that is off. */
  get: adminProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        title: pages.title,
        description: pages.description,
        body: pages.body,
        published: pages.published,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(eq(pages.slug, ANNOUNCEMENT_SLUG));
    return {
      enabled: row?.published ?? false,
      message: row?.title ?? "",
      linkLabel: row?.description ?? "",
      linkHref: row?.body ?? "",
      updatedAt: row?.updatedAt ?? null,
    };
  }),

  /**
   * Saves the banner. Every save, including switching it off and on, is a new
   * version, so a visitor who dismissed an earlier one sees this one.
   */
  set: adminProcedure
    .input(announcementInput)
    .mutation(async ({ ctx, input }) => {
      const fields = {
        title: input.message,
        description: input.linkLabel,
        body: input.linkHref,
        published: input.enabled,
        updatedAt: new Date(),
      };
      const [saved] = await ctx.db
        .insert(pages)
        .values({
          slug: ANNOUNCEMENT_SLUG,
          createdById: ctx.session.user.id,
          ...fields,
        })
        .onConflictDoUpdate({ target: pages.slug, set: fields })
        .returning({ updatedAt: pages.updatedAt });
      return { updatedAt: saved!.updatedAt };
    }),
});
