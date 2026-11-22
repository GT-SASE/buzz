import type { MetadataRoute } from "next";

import { eventPagePath } from "~/app/portal/_lib/paths";
import { site } from "~/data/site";

/**
 * Priorities reflect what a prospective member or a recruiter is actually
 * searching for, not an even spread: the homepage and /join carry the
 * conversion, /events changes most often.
 *
 * Public routes only, and deliberately hand-written rather than derived: the
 * /portal subtree is behind auth and disallowed in robots.txt, so listing it
 * would submit URLs that answer a crawler with a sign-in redirect and
 * contradict the `robots: { index: false }` those pages already declare.
 * Pages officers publish in the portal are the exception, and they are
 * appended from the database by `buildSitemap`.
 */
const routes = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/join", priority: 0.9, changeFrequency: "monthly" },
  { path: "/events", priority: 0.9, changeFrequency: "weekly" },
  { path: "/programs", priority: 0.8, changeFrequency: "monthly" },
  { path: "/about", priority: 0.7, changeFrequency: "yearly" },
  { path: "/sponsors", priority: 0.7, changeFrequency: "monthly" },
  { path: "/board", priority: 0.6, changeFrequency: "yearly" },
  { path: "/contact", priority: 0.6, changeFrequency: "yearly" },
  { path: "/discord", priority: 0.6, changeFrequency: "yearly" },
  { path: "/website-team", priority: 0.6, changeFrequency: "monthly" },
  { path: "/status", priority: 0.3, changeFrequency: "daily" },
] as const;

export type PublishedPageEntry = { slug: string; updatedAt: Date };

/** A public event page. `upcoming` ranks it above the archive. */
export type EventPageEntry = {
  id: string;
  modifiedAt: Date;
  upcoming: boolean;
};

export function buildSitemap(
  published: readonly PublishedPageEntry[],
  eventPages: readonly EventPageEntry[] = [],
): MetadataRoute.Sitemap {
  // No lastModified on the hand-written routes. They have no per-page content
  // date, and stamping `new Date()` made every URL look edited at build time.
  // A published page does have one: the row's updatedAt.
  return [
    ...routes.map((route) => ({
      url: route.path === "/" ? site.url : `${site.url}${route.path}`,
      changeFrequency: route.changeFrequency,
      priority: route.priority,
    })),
    ...published.map((page) => ({
      url: `${site.url}/${page.slug}`,
      lastModified: page.updatedAt,
      changeFrequency: "monthly" as const,
      priority: 0.5,
    })),
    ...eventPages.map((event) => ({
      url: `${site.url}${eventPagePath(event.id)}`,
      lastModified: event.modifiedAt,
      changeFrequency: event.upcoming
        ? ("weekly" as const)
        : ("yearly" as const),
      priority: event.upcoming ? 0.6 : 0.3,
    })),
  ];
}
