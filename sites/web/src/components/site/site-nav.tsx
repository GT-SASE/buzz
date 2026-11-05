"use client";

import { ChevronDown, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

import { Wordmark } from "~/components/site/brand";
import { Button } from "~/components/ui/button";
import { navCta, navGroups, site } from "~/data/site";
import { cn } from "~/lib/utils";

/** Nav rows, minus Join — the CTA is that link. */
const groups = navGroups.filter((group) => group.href !== "/join");

/** "/events#past" -> "/events" so aria-current only marks the real route. */
const toPath = (href: string) => href.split("#")[0];

const linkBase =
  "text-body-sm relative flex items-center gap-2 px-2.5 py-3 font-semibold transition xl:px-3";

/** Closes every open dropdown under `root`, except the one holding `keep`. */
function closeMenus(root: HTMLElement | null, keep?: EventTarget | null) {
  const open =
    root?.querySelectorAll<HTMLDetailsElement>("details[open]") ?? [];
  for (const menu of open) {
    if (!(keep instanceof Node && menu.contains(keep))) menu.open = false;
  }
}

export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const menusRef = useRef<HTMLUListElement>(null);
  const sheetRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The dropdowns are native <details>, so they open without any script. This
  // only adds what <details> lacks: closing on a press or focus outside, and
  // on Escape.
  useEffect(() => {
    const onOutside = (event: Event) =>
      closeMenus(menusRef.current, event.target);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const open =
        menusRef.current?.querySelector<HTMLDetailsElement>("details[open]");
      if (!open) return;
      open.open = false;
      open.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", onOutside);
    document.addEventListener("focusin", onOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onOutside);
      document.removeEventListener("focusin", onOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Back/forward or a same-page tap must never leave the sheet or a dropdown
  // stuck open.
  useEffect(() => {
    sheetRef.current?.close();
    closeMenus(menusRef.current);
  }, [pathname]);

  return (
    <header
      className={cn(
        "border-gold sticky top-0 z-50 border-b-2 backdrop-blur-md transition-colors duration-300",
        // Scrolling closes the ground: once copy runs under the bar it has to
        // be opaque paper rather than a tint over the text.
        scrolled ? "bg-paper" : "bg-paper/90",
      )}
    >
      <nav
        aria-label="Primary"
        className="max-w-content mx-auto flex items-center justify-between gap-3 px-5 py-3 sm:gap-6 sm:px-6 sm:py-4"
      >
        <Link href="/" className="inline-flex min-h-11 shrink-0 items-center">
          <Wordmark tone="dark" />
        </Link>

        <ul ref={menusRef} className="hidden items-center xl:flex">
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
                <details className="group relative">
                  <summary
                    className={cn(
                      linkClass,
                      "cursor-pointer list-none outline-none [&::-webkit-details-marker]:hidden",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    {group.label}
                    <ChevronDown className="size-3 transition-transform duration-200 group-open:rotate-180" />
                  </summary>
                  <div
                    onClick={() => closeMenus(menusRef.current)}
                    className="border-gold ring-hairline bg-paper group-open:animate-in group-open:fade-in-0 group-open:zoom-in-95 absolute top-full left-0 z-50 mt-3.5 w-56 origin-top-left overflow-hidden rounded-xl border-t-2 shadow-md ring-1 duration-200"
                  >
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={
                          toPath(item.href) === pathname &&
                          !item.href.includes("#")
                            ? "page"
                            : undefined
                        }
                        className="text-ink-muted hover:bg-cream hover:text-navy focus-visible:bg-cream focus-visible:text-navy text-body-sm border-hairline block w-full border-b px-4 py-3 last:border-b-0 focus-visible:shadow-none focus-visible:-outline-offset-2"
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </details>
              </li>
            );
          })}

          <li className="ml-4">
            <Button
              asChild
              className="text-body-sm bg-navy hover:bg-navy-deep h-auto rounded-full px-5 py-3 font-bold text-white [font-stretch:112%]"
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

        <Button
          variant="ghost"
          size="icon"
          aria-label="Open menu"
          aria-haspopup="dialog"
          onClick={() => sheetRef.current?.showModal()}
          className="text-navy -mr-2 size-11 rounded-none xl:hidden"
        >
          <Menu className="size-6" />
        </Button>

        {/* A native modal <dialog>: the browser traps focus, inerts the page
            and closes on Escape. A press on the backdrop lands on the dialog
            itself, which has no padding of its own, so that is the only way
            the target can be the dialog. */}
        <dialog
          ref={sheetRef}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          onClick={(event) => {
            const target = event.target as Element;
            if (target === event.currentTarget || target.closest("a")) {
              event.currentTarget.close();
            }
          }}
          className="bg-paper fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-full max-w-none translate-x-full overflow-hidden border-0 p-0 opacity-0 shadow-lg transition-[translate,opacity,display,overlay] transition-discrete duration-300 ease-out backdrop:bg-black/0 backdrop:transition-[background-color,display,overlay] backdrop:transition-discrete backdrop:duration-300 open:block open:translate-x-0 open:opacity-100 open:backdrop:bg-black/50 sm:max-w-sm starting:open:translate-x-full starting:open:opacity-0 starting:open:backdrop:bg-black/0"
        >
          <div className="flex h-full flex-col px-5 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
            <div className="flex flex-row items-center justify-between gap-1.5 px-0 py-1">
              <h2 id={titleId} className="sr-only">
                Site menu
              </h2>
              <p id={descriptionId} className="sr-only">
                Chapter pages, how to join, and how to reach us.
              </p>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close menu"
                onClick={() => sheetRef.current?.close()}
                className="text-navy ml-auto size-11 rounded-none"
              >
                <X className="size-6" />
              </Button>
            </div>

            <Button
              asChild
              className="text-body bg-navy hover:bg-navy-deep h-auto w-full rounded-full px-6 py-4 font-bold text-white [font-stretch:112%]"
            >
              <Link href={navCta.href}>{navCta.label}</Link>
            </Button>

            <div className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                            className="text-ink-muted text-body-sm block min-h-11 py-3"
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}

              <a
                href={`mailto:${site.email}`}
                className="text-ink-muted text-body-sm mt-6 block py-3"
              >
                {site.email}
              </a>
            </div>
          </div>
        </dialog>
      </nav>
    </header>
  );
}
