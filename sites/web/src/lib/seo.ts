import type { Metadata } from "next";

import { site } from "~/data/site";

/**
 * Share image served by `app/opengraph-image.tsx`. A page that sets its own
 * `openGraph` object replaces the layout's resolved tags, so the file-based
 * image never reaches the document unless this URL is set explicitly.
 * Absolute: link-preview crawlers do not resolve a relative image path.
 */
export const shareImage = {
  url: `${site.url}/opengraph-image`,
  width: 1200,
  height: 630,
  alt: `${site.name} — ${site.tagline}`,
  type: "image/png",
} as const;

/**
 * Per-page metadata. `title` is the full document title. It is absolute so the
 * root layout's portal suffix (`%s · GT SASE`) stays off the public pages, and
 * the same string is used for the Open Graph and Twitter titles.
 *
 * `path` is the route, leading slash, no trailing slash ("/board", "/" for home).
 */
export function pageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  const url = path === "/" ? site.url : `${site.url}${path}`;

  return {
    title: { absolute: title },
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      siteName: site.name,
      locale: "en_US",
      type: "website",
      images: [shareImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [shareImage.url],
    },
  };
}

/**
 * Google Search Console HTML-tag verification. Pass
 * `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`. An empty value emits no tag.
 */
export function googleSiteVerification(
  token: string | undefined,
): Metadata["verification"] {
  if (!token) return undefined;
  return { google: token };
}

/** Serialises JSON-LD for a <script type="application/ld+json"> tag. */
export function jsonLd(data: Record<string, unknown>) {
  // `<` is escaped so a stray "</script>" inside chapter copy cannot close the
  // tag early; JSON.stringify alone does not protect against that.
  return { __html: JSON.stringify(data).replace(/</g, "\\u003c") };
}

/** The chapter itself. Rendered once, in the root layout. */
export function organizationSchema() {
  return {
    "@context": "https://schema.org",
    "@type": "CollegeOrStudentOrganization",
    "@id": `${site.url}/#organization`,
    name: site.name,
    alternateName: ["GT SASE", site.name, site.shortName, site.tagline],
    url: site.url,
    email: site.email,
    description: site.description,
    parentOrganization: {
      "@type": "Organization",
      name: "Society of Asian Scientists and Engineers",
      url: site.parentOrganization,
    },
    memberOf: {
      "@type": "CollegeOrUniversity",
      name: "Georgia Institute of Technology",
      url: "https://www.gatech.edu/",
    },
    address: {
      "@type": "PostalAddress",
      addressLocality: site.locality,
      addressRegion: site.region,
      addressCountry: "US",
    },
    sameAs: site.socials.map((social) => social.href),
  };
}

/**
 * One chapter event.
 *
 * `startsAt` is a real instant, so it is emitted as a fully qualified ISO 8601
 * string with its offset.
 *
 * Location and description are omitted rather than defaulted when the officer
 * left them blank. A placeholder like "Location announced on Instagram" is fine
 * on a card, but asserting it as a venue name in structured data would have
 * search engines index it as the event's actual place — alongside a postal
 * address that is real.
 */
export function eventSchema(event: {
  title: string;
  startsAt: Date;
  location: string | null;
  description: string | null;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    startDate: event.startsAt.toISOString(),
    ...(event.description ? { description: event.description } : {}),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: "https://schema.org/EventScheduled",
    organizer: { "@id": `${site.url}/#organization` },
    ...(event.location
      ? {
          location: {
            "@type": "Place",
            name: event.location,
            address: {
              "@type": "PostalAddress",
              addressLocality: site.locality,
              addressRegion: site.region,
              addressCountry: "US",
            },
          },
        }
      : {}),
    isAccessibleForFree: true,
  };
}

/** Trail for an interior page. Home is implicit as the first crumb. */
export function breadcrumbSchema(label: string, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: site.url,
      },
      {
        "@type": "ListItem",
        position: 2,
        name: label,
        item: `${site.url}${path}`,
      },
    ],
  };
}
