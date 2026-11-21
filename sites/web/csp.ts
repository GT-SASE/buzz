import { RESERVED_PAGE_SLUGS } from "@buzz/api/page-slug";

import { uptimeDataUrl } from "./src/lib/uptime";

/**
 * Pages that render officer-written Markdown, whose images may live on any
 * https host (components/site/markdown.tsx). Everything else keeps images to
 * this origin and data: URLs.
 */
export const markdownSources = [
  // (marketing)/[slug]: a top-level slug that no static route owns.
  `/:slug((?!(?:${[...RESERVED_PAGE_SLUGS].join("|")})$)[a-z0-9]+(?:-[a-z0-9]+)*)`,
  // The page editor's live preview.
  "/portal/admin/pages/:path*",
];

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
 * Next applies every matching rule in order and a later rule replaces the
 * same header of an earlier one, so the default comes first.
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
    rule("/:path*"),
    // The browser reads the uptime JSON from GitHub (lib/uptime.ts).
    rule("/status", { connect: new URL(uptimeDataUrl).origin }),
    ...markdownSources.map((source) => rule(source, { img: "https:" })),
  ];
}
