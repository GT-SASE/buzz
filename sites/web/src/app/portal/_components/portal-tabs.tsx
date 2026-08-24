"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Button } from "~/components/ui/button";
import { adminNav, portalNav } from "~/data/portal";
import { cn } from "~/lib/utils";

/** Route links, not panel switchers — real anchors keep prefetch and open-in-tab. */
export function PortalTabs({ isOfficer }: { isOfficer: boolean }) {
  const pathname = usePathname();
  const tabs = isOfficer
    ? [{ href: "/portal", label: "My card" }, ...adminNav]
    : portalNav;

  // Longest matching href wins, so a nested route lights one tab rather than
  // putting aria-current="page" on itself and on its parent.
  let activeHref = "";
  for (const tab of tabs) {
    const matches =
      pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (matches && tab.href.length > activeHref.length) activeHref = tab.href;
  }

  return (
    <nav aria-label="Portal" className="border-hairline border-t">
      <ul
        role="list"
        className="max-w-content mx-auto flex min-w-0 items-center gap-1 overflow-x-auto px-3 sm:px-6"
      >
        {tabs.map((tab) => {
          const active = tab.href === activeHref;

          return (
            <li key={tab.href}>
              <Button
                asChild
                variant="ghost"
                className={cn(
                  "text-body-sm hover:bg-cream relative h-auto min-h-11 shrink-0 rounded-none px-3 py-3.5 font-medium sm:px-4",
                  active
                    ? "text-navy hover:text-navy after:bg-gold-bright after:absolute after:inset-x-3 after:bottom-0 after:h-0.5"
                    : "text-ink-muted hover:text-navy",
                )}
              >
                {/* "page" only on an exact match: on a detail route the
                    breadcrumb is the current page, and this link is not. */}
                <Link
                  href={tab.href}
                  aria-current={
                    !active
                      ? undefined
                      : pathname === tab.href
                        ? "page"
                        : "true"
                  }
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
