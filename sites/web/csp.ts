import { RESERVED_PAGE_SLUGS } from "@buzz/api/page-slug";

import { uptimeDataUrl } from "./src/lib/uptime";

/** A top-level URL that (marketing)/[slug] serves: valid and not owned by a static route. */
const cmsSlug = `(?!(?:${[...RESERVED_PAGE_SLUGS].join("|")})$)[a-z0-9]+(?:-[a-z0-9]+)*`;

/**
 * Pages that render officer-written Markdown, whose images may live on any
 * https host (components/site/markdown.tsx). Everything else keeps images to
 * this origin and data: URLs.
 */
const markdownSources = [
  `/:slug(${cmsSlug})`,
  // The page editor's live preview.
  "/portal/admin/pages/:path*",
];

const statusSource = "/status";

/** Every path that is none of the above. */
const defaultSource = `/:path((?!status$|portal/admin/pages(?:/|$)|(?:${cmsSlug})$).*)`;

/**
 * One policy, widened per route. By default it allows only this origin:
 * Vercel Analytics and Speed Insights load from /_vercel/* and report there,
 * and every image is a local file or a data: URL (the check-in QR).
 *
 * Production scripts keep 'unsafe-inline' because a nonce forces every page to
 * render per request; AGENTS.md has the measurement.
 */
export function contentSecurityPolicy(
  isProd: boolean,
  { img = "", connect = "" } = {},
) {
  return [
    "default-src 'self'",
    isProd
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${img}`.trim(),
    "font-src 'self' data:",
    `connect-src 'self' ${connect}`.trim(),
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * The sources never overlap, so each URL gets exactly one policy and nothing
 * depends on how a host orders or merges two matching rules.
 */
export function cspHeaderRules(isProd: boolean) {
  const rule = (
    source: string,
    options?: Parameters<typeof contentSecurityPolicy>[1],
  ) => ({
    source,
    headers: [
      {
        key: "Content-Security-Policy",
        value: contentSecurityPolicy(isProd, options),
      },
    ],
  });

  return [
    rule(defaultSource),
    // The browser reads the uptime JSON from GitHub (lib/uptime.ts).
    rule(statusSource, { connect: new URL(uptimeDataUrl).origin }),
    ...markdownSources.map((source) => rule(source, { img: "https:" })),
  ];
}
