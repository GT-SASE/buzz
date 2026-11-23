export const PAGE_SLUG_MAX = 60;

/**
 * The site-wide announcement banner is stored as a row of the page table under
 * this slug, so it needs no table of its own. The slug is reserved: an officer
 * cannot create a page here, `/site-banner` is never served as one, and the
 * page list and the sitemap skip the row.
 */
export const ANNOUNCEMENT_SLUG = "site-banner";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every name a top-level URL already answers to. A published page at one of
 * these would be shadowed by the static route, or worse, shadow a metadata
 * file. tests/page-slug.test.ts fails when a route folder is added without
 * being listed here.
 */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set([
  "about",
  "api",
  "board",
  "contact",
  "discord",
  "events",
  "events.ics",
  "faq",
  "join",
  "portal",
  "programs",
  "site-banner",
  "sponsors",
  "status",
  "website-team",
  "apple-icon",
  "favicon",
  "icon",
  "manifest",
  "opengraph-image",
  "robots",
  "sitemap",
  "twitter-image",
]);

/** The reason a slug is unusable, or null when it is fine. */
export function pageSlugProblem(slug: string): string | null {
  if (slug.length === 0) return "Enter a URL.";
  if (slug.length > PAGE_SLUG_MAX) {
    return `Keep the URL under ${PAGE_SLUG_MAX} characters.`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return "Use lowercase letters, numbers, and single hyphens.";
  }
  if (RESERVED_PAGE_SLUGS.has(slug)) return `"${slug}" is already a page.`;
  return null;
}

export function isValidPageSlug(slug: string) {
  return pageSlugProblem(slug) === null;
}

/** A starting point for the URL field, trimmed to fit and not yet validated. */
export function slugFromTitle(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PAGE_SLUG_MAX)
    .replace(/-+$/g, "");
}
