"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Wordmark } from "~/app/_components/ui";
import { navCta, navGroups, site } from "~/data/site";

/**
 * First-paint offset for the mobile panel, replaced by the measured header
 * height on mount. The header is taller below `lg` (the 44px hamburger, not
 * the 36px wordmark, sets the row height), so this is never hardcoded as final.
 */
const HEADER_H_FALLBACK = 77;

/** Nav rows, minus the entry the CTA pill already covers. */
const groups = navGroups.filter((group) => group.href !== navCta.href);

/** "/events#past" -> "/events" so aria-current only marks the real route. */
const toPath = (href: string) => href.split("#")[0];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const [headerH, setHeaderH] = useState(HEADER_H_FALLBACK);
  const pathname = usePathname();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  /** Keyed by group label so Escape can hand focus back to the right trigger. */
  const triggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // The panel hangs off the real header, whatever the breakpoint makes it.
  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => setHeaderH(header.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  // Back/forward or an in-panel tap must never leave the menu stuck open.
  // Adjusted during render rather than in an effect so the closed menu paints
  // in the same commit as the new route.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
    setOpenMenu(null);
  }

  // Lock the page behind the full-screen mobile panel, and take the content it
  // covers out of the tab order — otherwise Tab walks into links hidden by the
  // overlay and the focus ring disappears. The skip link goes with them: it
  // targets #content, so following it while the panel is open sends focus to an
  // inert <main>, focus falls back to <body>, and the next Tab restarts at the
  // top of the page with the panel still open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const covered = Array.from(
      document.querySelectorAll("#skip-to-content, main, footer"),
    );
    covered.forEach((el) => el.setAttribute("inert", ""));
    return () => {
      document.body.style.overflow = previous;
      covered.forEach((el) => el.removeAttribute("inert"));
    };
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Closing a dropdown unmounts whatever holds focus, so hand it back to
      // the control that opened it rather than dropping it on <body>.
      if (openMenu) triggerRefs.current[openMenu]?.focus();
      setOpenMenu(null);
      if (open) {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [openMenu]);

  /** Hover is an enhancement only — coarse pointers use the button. */
  const hoverOpen = (label: string | null) => {
    if (window.matchMedia("(hover: hover)").matches) setOpenMenu(label);
  };

  return (
    <header
      ref={headerRef}
      className={`border-hairline bg-paper/95 sticky top-0 z-50 border-b backdrop-blur-md transition-shadow duration-300 ${
        scrolled
          ? "shadow-[0_1px_0_rgb(66_48_20/0.08),0_10px_28px_-22px_rgb(66_48_20/0.35)]"
          : ""
      }`}
    >
      <nav
        ref={barRef}
        aria-label="Primary"
        className="max-w-content mx-auto flex items-center justify-between gap-6 px-5 py-4 sm:px-6"
      >
        <Link href="/" onClick={() => setOpen(false)} className="shrink-0">
          <Wordmark tone="dark" />
        </Link>

        <ul className="hidden items-center gap-1 lg:flex">
          {groups.map((group) => {
            const active =
              pathname === group.href ||
              group.items.some((item) => toPath(item.href) === pathname);
            const menuId = `menu-${group.href.replace(/\W+/g, "-")}`;
            const linkClass = `text-body-sm relative flex items-center gap-1.5 px-4 py-2 font-medium transition ${
              active
                ? "text-navy after:bg-gold-bright after:absolute after:inset-x-4 after:-bottom-px after:h-0.5"
                : "text-ink-muted hover:text-navy"
            }`;

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

            const expanded = openMenu === group.label;

            return (
              <li
                key={group.href}
                className="relative"
                onMouseEnter={() => hoverOpen(group.label)}
                onMouseLeave={(event) => {
                  // The pointer wandering off must not steal a keyboard user's
                  // place inside the panel.
                  if (event.currentTarget.contains(document.activeElement))
                    return;
                  hoverOpen(null);
                }}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setOpenMenu(null);
                }}
              >
                <button
                  type="button"
                  ref={(el) => {
                    triggerRefs.current[group.label] = el;
                  }}
                  aria-expanded={expanded}
                  aria-controls={menuId}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpenMenu(expanded ? null : group.label)}
                  className={linkClass}
                >
                  {group.label}
                  <svg
                    viewBox="0 0 10 6"
                    aria-hidden="true"
                    focusable="false"
                    className={`h-1.5 w-2.5 transition-transform duration-200 ${
                      expanded ? "rotate-180" : ""
                    }`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m1 1 4 4 4-4" />
                  </svg>
                </button>

                {/* Always rendered so `aria-controls` above resolves to a real
                    element; `hidden` collapses it while it is closed. */}
                <ul
                  id={menuId}
                  hidden={!expanded}
                  className="rounded-card ring-hairline bg-paper absolute left-0 top-full mt-2 w-56 p-2 shadow-[0_20px_45px_-22px_rgb(66_48_20/0.5)] ring-1"
                >
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
                        onClick={() => setOpenMenu(null)}
                        className="text-ink-muted hover:bg-cream hover:text-navy text-body-sm block rounded-md px-3 py-2.5 transition"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
          {/* Written out here rather than added to `navGroups`: that array also
              drives the footer's Explore list, and the active test above is an
              exact path match, so /portal/check-in and /portal/admin would
              render with no active state. Text, never a pill — the CTA below is
              the one high-emphasis action in the chrome. */}
          <li>
            <Link
              href="/portal"
              prefetch={false}
              className="text-ink-muted hover:text-navy text-body-sm inline-flex items-center px-4 py-2 font-medium transition"
            >
              Member portal
            </Link>
          </li>
          <li className="ml-3">
            <Link
              href={navCta.href}
              aria-current={pathname === navCta.href ? "page" : undefined}
              className="bg-navy hover:bg-navy-deep text-body-sm inline-flex items-center rounded-full px-5 py-2.5 font-semibold text-white shadow-[0_1px_2px_rgb(66_48_20/0.18)] transition"
            >
              {navCta.label}
            </Link>
          </li>
        </ul>

        <button
          ref={toggleRef}
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
          className="text-navy -mr-2 flex h-11 w-11 items-center justify-center lg:hidden"
        >
          <span className="flex flex-col gap-[5px]">
            <span
              className={`bg-navy block h-[2px] w-5 transition ${open ? "translate-y-[7px] rotate-45" : ""}`}
            />
            <span
              className={`bg-navy block h-[2px] w-5 transition ${open ? "opacity-0" : ""}`}
            />
            <span
              className={`bg-navy block h-[2px] w-5 transition ${open ? "-translate-y-[7px] -rotate-45" : ""}`}
            />
          </span>
        </button>
      </nav>

      {open && (
        <nav
          id="mobile-menu"
          aria-label="Mobile"
          style={{ top: headerH }}
          className="border-hairline bg-paper fixed inset-x-0 bottom-0 z-40 overflow-y-auto overscroll-contain border-t px-5 pb-10 lg:hidden"
        >
          <Link
            href={navCta.href}
            onClick={() => setOpen(false)}
            className="bg-navy text-body-sm mt-5 inline-flex items-center rounded-full px-5 py-3 font-semibold text-white"
          >
            {navCta.label}
          </Link>

          {groups.map((group) => {
            const active = pathname === group.href;
            return (
              <div key={group.href} className="border-hairline border-b py-3">
                <Link
                  href={group.href}
                  aria-current={active ? "page" : undefined}
                  onClick={() => setOpen(false)}
                  className="font-display text-navy block py-3 text-base font-bold"
                >
                  {group.label}
                </Link>
                {group.items.length > 0 && (
                  <ul className="mt-1">
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
                          onClick={() => setOpen(false)}
                          className="text-ink/70 text-body-sm -mx-2 block px-2 py-2.5"
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}

          {/* py-3 on both, here and on the group links above: at py-1.5 these
              rows measured about 34px, under the 44px minimum touch target,
              which is the size the hamburger is already built to. */}
          <Link
            href="/portal"
            prefetch={false}
            onClick={() => setOpen(false)}
            className="text-ink-muted text-body-sm mt-6 block py-3"
          >
            Member portal
          </Link>

          <a
            href={`mailto:${site.email}`}
            className="text-ink-muted text-body-sm block py-3"
          >
            {site.email}
          </a>
        </nav>
      )}
    </header>
  );
}
