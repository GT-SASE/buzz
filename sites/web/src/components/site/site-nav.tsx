"use client";

import { ChevronDown, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Wordmark } from "~/components/site/brand";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
import { navCta, navGroups, site } from "~/data/site";
import { cn } from "~/lib/utils";

/** Nav rows, minus the entry the CTA block already covers. */
const groups = navGroups.filter((group) => group.href !== navCta.href);

/** "/events#past" -> "/events" so aria-current only marks the real route. */
const toPath = (href: string) => href.split("#")[0];

const linkBase =
  "text-eyebrow tracking-caps relative flex items-center gap-2 px-2.5 py-3 font-semibold uppercase transition lg:px-2 xl:px-3";

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Back/forward or an in-panel tap must never leave the sheet stuck open.
  // Adjusted during render so the closed panel paints in the same commit as
  // the new route.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  return (
    <header
      className={cn(
        "border-rule sticky top-0 z-50 border-b-2 backdrop-blur-md transition-colors duration-300",
        // Scrolling closes the ground: once copy runs under the bar it has to
        // be opaque paper rather than a tint over the text.
        scrolled ? "bg-paper" : "bg-paper/90",
      )}
    >
      <nav
        aria-label="Primary"
        className="max-w-content mx-auto flex items-center justify-between gap-3 px-5 py-3 sm:gap-6 sm:px-6 sm:py-4"
      >
        <Link href="/" className="shrink-0">
          <Wordmark tone="dark" />
        </Link>

        <ul className="hidden items-center lg:flex">
          {groups.map((group) => {
            const active =
              pathname === group.href ||
              group.items.some((item) => toPath(item.href) === pathname);
            const linkClass = cn(
              linkBase,
              active
                ? "text-navy after:bg-navy after:absolute after:inset-x-2 after:bottom-1 after:h-0.5"
                : "text-ink-muted hover:text-navy",
            );

            if (group.items.length === 0) {
              return (
                <li key={group.href}>
                  <Link
                    href={group.href}
                    aria-current={active ? "page" : undefined}
                    className={linkClass}
                  >
                    {group.label}
                  </Link>
                </li>
              );
            }

            return (
              <li key={group.href}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    className={cn(linkClass, "group outline-none")}
                    aria-current={active ? "page" : undefined}
                  >
                    {group.label}
                    <ChevronDown className="size-3 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    sideOffset={14}
                    className="border-rule ring-hairline bg-paper w-56 rounded-none border-0 border-t-2 p-0 ring-1"
                  >
                    {/* A real <Link> inside the item rather than `asChild`:
                        Watermelon's motion-wrapped DropdownMenuItem omits that
                        prop. The anchor keeps middle-click and crawlability;
                        onSelect is what makes Enter navigate, since Radix
                        dispatches selection on the item, not the child. */}
                    {group.items.map((item) => (
                      <DropdownMenuItem
                        key={item.href}
                        onSelect={() => router.push(item.href)}
                        className="rounded-none p-0"
                      >
                        <Link
                          href={item.href}
                          aria-current={
                            toPath(item.href) === pathname &&
                            !item.href.includes("#")
                              ? "page"
                              : undefined
                          }
                          className="text-ink-muted hover:bg-cream hover:text-navy text-body-sm border-hairline block w-full border-b px-4 py-3 last:border-b-0"
                        >
                          {item.label}
                        </Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}

          {/* Written out here rather than added to `navGroups`: that array also
              drives the footer's Explore list, and the active test above is an
              exact path match, so /portal/check-in would render inactive. */}
          <li>
            <Link
              href="/portal"
              prefetch={false}
              className="text-ink-muted hover:text-navy text-eyebrow tracking-caps inline-flex items-center px-2.5 py-3 font-semibold uppercase transition"
            >
              Member portal
            </Link>
          </li>
          <li className="ml-4">
            <Button
              asChild
              className="text-eyebrow tracking-caps bg-navy hover:bg-navy-deep h-auto rounded-none px-4 py-3 font-semibold text-white uppercase"
            >
              <Link
                href={navCta.href}
                aria-current={pathname === navCta.href ? "page" : undefined}
              >
                {navCta.label}
              </Link>
            </Button>
          </li>
        </ul>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open menu"
              className="text-navy -mr-2 size-11 rounded-none lg:hidden"
            >
              <Menu className="size-6" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="bg-paper w-full gap-0 border-0 px-5 pb-10 sm:max-w-sm"
          >
            <SheetHeader className="px-0">
              <SheetTitle className="sr-only">Site menu</SheetTitle>
              <SheetDescription className="sr-only">
                Chapter pages, the member portal, and how to reach us.
              </SheetDescription>
            </SheetHeader>

            <Button
              asChild
              className="text-eyebrow tracking-caps bg-navy hover:bg-navy-deep mt-2 h-auto w-full rounded-none px-6 py-4 font-semibold text-white uppercase"
            >
              <Link href={navCta.href}>{navCta.label}</Link>
            </Button>

            <div className="mt-2 overflow-y-auto">
              {groups.map((group) => (
                <div key={group.href} className="border-hairline border-b py-3">
                  <Link
                    href={group.href}
                    aria-current={pathname === group.href ? "page" : undefined}
                    className="font-display text-navy text-h3 block py-3 font-bold"
                  >
                    {group.label}
                  </Link>
                  {group.items.length > 0 && (
                    <ul className="border-hairline mt-1 border-l pl-4">
                      {group.items.map((item) => (
                        <li key={item.href}>
                          <Link
                            href={item.href}
                            aria-current={
                              toPath(item.href) === pathname &&
                              !item.href.includes("#")
                                ? "page"
                                : undefined
                            }
                            className="text-ink-muted text-body-sm block py-2.5"
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}

              {/* py-3 throughout: at py-1.5 these rows measured ~34px, under
                  the 44px minimum touch target. */}
              <Link
                href="/portal"
                prefetch={false}
                className="text-ink-muted text-body-sm tracking-caps mt-6 block py-3 font-semibold uppercase"
              >
                Member portal
              </Link>

              <a
                href={`mailto:${site.email}`}
                className="text-ink-muted text-body-sm block py-3"
              >
                {site.email}
              </a>
            </div>
          </SheetContent>
        </Sheet>
      </nav>
    </header>
  );
}
