"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "~/components/ui/button";
import { adminNav, portalNav } from "~/data/portal";
import { cn } from "~/lib/utils";

/** Route links, not panel switchers — real anchors keep prefetch and open-in-tab. */
export function PortalTabs({ isOfficer }: { isOfficer: boolean }) {
  const pathname = usePathname();
  const tabs = isOfficer ? [...portalNav, ...adminNav] : portalNav;

  return (
    <nav aria-label="Portal" className="border-hairline border-t">
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
              <Button
                asChild
                variant="ghost"
                className={cn(
                  "text-body-sm hover:bg-cream relative h-auto rounded-none px-4 py-3.5 font-medium",
                  active
                    ? "text-navy hover:text-navy after:bg-gold-bright after:absolute after:inset-x-3 after:bottom-0 after:h-0.5"
                    : "text-ink-muted hover:text-navy",
                )}
              >
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                >
                  {tab.label}
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
