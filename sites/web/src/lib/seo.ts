import type { Metadata } from "next";

import { site } from "~/data/site";

/**
 * Per-page metadata. Every page gets its own title, description, canonical URL
 * and Open Graph entry — a shared root-level OG block makes every share card on
 * every page identical, which is what the site had before.
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
  // The template in the root layout appends the chapter name to every child
  // title; openGraph.title does not inherit it, so it is spelled out here.
  const fullTitle = path === "/" ? title : `${title} · ${site.shortName}`;

  return {
    // The root layout's title template appends the chapter name to every child
    // title. The homepage title already carries it, so it opts out.
    title: path === "/" ? { absolute: title } : title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: fullTitle,
      description,
      url,
      siteName: site.name,
      locale: "en_US",
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
    },
  };
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
    alternateName: [site.shortName, site.tagline],
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
