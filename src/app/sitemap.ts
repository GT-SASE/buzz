import type { MetadataRoute } from "next";

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
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  // Static export: this is build time, which is when the content last changed.
  const lastModified = new Date();

  return routes.map((route) => ({
    url: route.path === "/" ? site.url : `${site.url}${route.path}`,
    lastModified,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));
}
