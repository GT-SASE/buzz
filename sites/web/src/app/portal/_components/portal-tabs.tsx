"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { adminNav, portalNav } from "~/data/portal";

/**
 * The portal's own tab rail, under the site header.
 *
 * The site nav is left alone on purpose: a member who lands here should still
 * be one click from /events and /join, and duplicating the whole header would
 * mean two competing navigations on the same page.
 */
export function PortalTabs({ isOfficer }: { isOfficer: boolean }) {
  const pathname = usePathname();
  const tabs = isOfficer ? [...portalNav, ...adminNav] : portalNav;

  return (
    // Not sticky: the site header already owns `top-0`, so a second sticky bar
    // would slide underneath it and disappear on scroll.
    <nav aria-label="Portal" className="border-hairline bg-paper border-b">
      <ul
        role="list"
        className="max-w-content mx-auto flex items-center gap-1 overflow-x-auto px-5 sm:px-6"
      >
        {tabs.map((tab) => {
          // /portal must match exactly or it stays lit on every child route.
          const active =
            tab.href === "/portal"
              ? pathname === tab.href
              : pathname.startsWith(tab.href);

          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`text-body-sm relative block whitespace-nowrap px-4 py-4 font-medium transition ${
                  active
                    ? "text-navy after:bg-gold-bright after:absolute after:inset-x-3 after:bottom-0 after:h-0.5"
                    : "text-ink-muted hover:text-navy"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
