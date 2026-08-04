import type { MetadataRoute } from "next";

import { site } from "~/data/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        // Route handlers, not pages: nothing to index and the auth one bounces.
        "/api/",
        // The member portal. Bare prefix, not "/portal/", or the portal index
        // itself stays crawlable. This only asks crawlers not to fetch these —
        // it is a crawl directive, not an index directive, so it cannot keep a
        // URL reached from an outside link out of the results on its own.
        // `src/app/portal/layout.tsx` carries `robots: { index: false, follow:
        // false }` as the other half.
        "/portal",
      ],
    },
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
