/**
 * Site identity and navigation for SASE @ Georgia Tech.
 *
 * This module is imported by the client-side nav, so it must stay pure data —
 * no formatters, no `Date.now()`, no array work at module scope. Page copy
 * (events, board, programs, sponsors) lives in `~/data/content`.
 *
 * Contact and socials are taken from the chapter's public site
 * (sites.gatech.edu/gtsase). Swap `url` if the chapter registers its own domain.
 */

export const site = {
  name: "SASE at Georgia Tech",
  shortName: "SASE GT",
  tagline: "Society of Asian Scientists and Engineers",
  /**
   * The chapter theme. Rendered as a lockup in the hero, the footer, and the
   * share card — not as the site title, which stays searchable.
   */
  theme: "Buzz by SASE",
  description:
    "The Georgia Tech chapter of the Society of Asian Scientists and Engineers — preparing Asian heritage students for success in the global business world.",
  /**
   * Canonical origin, no trailing slash. Every canonical URL, the sitemap,
   * robots.txt, and the OG image URLs are built from this.
   */
  url: "https://buzzsase.vercel.app",
  locality: "Atlanta",
  region: "GA",
  parentOrganization: "https://www.saseconnect.org/",
  email: "gt@saseconnect.org",
  socials: [
    {
      id: "instagram",
      label: "Instagram",
      href: "https://www.instagram.com/gtsase/",
    },
    {
      id: "linkedin",
      label: "LinkedIn",
      href: "https://www.linkedin.com/company/society-of-asian-scientists-and-engineers-sase-georgia-tech-chapter/",
    },
    {
      id: "discord",
      label: "Discord",
      href: "https://discord.gg/vTBgABKf8J",
    },
    {
      id: "engage",
      label: "Engage",
      href: "https://gatech.campuslabs.com/engage/organization/society-of-asian-scientists-and-engineers",
    },
    {
      id: "national",
      label: "National SASE",
      href: "https://www.saseconnect.org/",
    },
  ],
} as const;

type Social = (typeof site.socials)[number];

/**
 * Named handles for the feeds pages link to directly. Keyed by `id` so a
 * label rename cannot silently drop the link from /contact, /join, /events.
 */
const bySocialId = (id: Social["id"]) => site.socials.find((s) => s.id === id);

export const instagram = bySocialId("instagram");
export const discord = bySocialId("discord");
export const engage = bySocialId("engage");

type NavGroup = {
  label: string;
  href: string;
  /**
   * Dropdown entries. The first item MUST be the group's own landing page —
   * the desktop trigger is a disclosure button, not a link, so `href` above is
   * only reachable from inside the panel.
   */
  items: { label: string; href: string }[];
};

/** Single source of truth for the header; the footer derives its list from it. */
export const navGroups: NavGroup[] = [
  { label: "About", href: "/about", items: [] },
  { label: "Programs", href: "/programs", items: [] },
  { label: "Board", href: "/board", items: [] },
  {
    label: "Events",
    href: "/events",
    items: [
      { label: "Upcoming", href: "/events" },
      { label: "Past events", href: "/events#past" },
    ],
  },
  { label: "Sponsors", href: "/sponsors", items: [] },
  { label: "Contact", href: "/contact", items: [] },
  { label: "Join", href: "/join", items: [] },
];

/** The one high-emphasis call to action in the site chrome. */
export const navCta = { label: "Join SASE", href: "/portal" } as const;
