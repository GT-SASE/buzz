"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { Wordmark } from "~/components/site";
import { Button } from "~/components/ui/button";
import { adminNav, portalNav } from "~/data/portal";
import { cn } from "~/lib/utils";

type SidebarProps = {
  isOfficer: boolean;
  name: string | null;
  email: string | null;
  /** The server-action sign-out form, passed in so this file stays client-only. */
  signOut: React.ReactNode;
};

/** The officer view is `/portal/admin` and everything under it. */
function isOfficerPath(pathname: string) {
  return pathname === "/portal/admin" || pathname.startsWith("/portal/admin/");
}

/** Route links, not panel switchers — real anchors keep prefetch and open-in-tab. */
export function PortalSidebar({
  isOfficer,
  name,
  email,
  signOut,
}: SidebarProps) {
  const pathname = usePathname();
  const sheetRef = useRef<HTMLDialogElement>(null);

  // A link click navigates, so the pathname is the one signal that covers it
  // and the back button alike.
  useEffect(() => {
    sheetRef.current?.close();
  }, [pathname]);

  // The sheet is lg:hidden, so one left open while the window widens would
  // keep its scroll lock with nothing on screen to dismiss.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    const close = () => {
      if (desktop.matches) sheetRef.current?.close();
    };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);

  return (
    <>
      {/* Mobile: a top bar with the menu in a sheet. */}
      <header className="border-gold bg-paper sticky top-0 z-40 border-b-2 pt-[env(safe-area-inset-top)] lg:hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
          <Brand />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => sheetRef.current?.showModal()}
            className="text-ink-muted hover:text-navy hover:bg-cream text-body-sm min-h-11 rounded-md font-semibold"
          >
            <Menu aria-hidden="true" className="size-4" />
            Menu
          </Button>
        </div>
      </header>

      {/* A native modal <dialog>: the browser traps focus, inerts the page and
          closes on Escape. A press on the backdrop lands on the dialog itself,
          which has no padding or border of its own, so that is the only way the
          target can be the dialog. */}
      <dialog
        ref={sheetRef}
        aria-label="Portal menu"
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
        className="fixed inset-y-0 right-auto left-0 m-0 h-full max-h-none w-72 max-w-[85vw] -translate-x-full overflow-hidden border-0 p-0 opacity-0 shadow-lg transition-[translate,opacity,display,overlay] transition-discrete duration-300 ease-out backdrop:bg-black/0 backdrop:transition-[background-color,display,overlay] backdrop:transition-discrete backdrop:duration-300 open:block open:translate-x-0 open:opacity-100 open:backdrop:bg-black/50 lg:hidden starting:open:-translate-x-full starting:open:opacity-0 starting:open:backdrop:bg-black/0"
      >
        <div className="bg-paper border-hairline flex h-full flex-col overflow-y-auto overscroll-contain border-r pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center justify-between px-4">
            <Brand />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close menu"
              onClick={() => sheetRef.current?.close()}
              className="text-navy size-11"
            >
              <X aria-hidden="true" className="size-6" />
            </Button>
          </div>
          <SidebarContents
            isOfficer={isOfficer}
            name={name}
            email={email}
            signOut={signOut}
            pathname={pathname}
            onNavigate={() => sheetRef.current?.close()}
          />
        </div>
      </dialog>

      {/* Desktop: a fixed-width column that stays put while the page scrolls. */}
      <aside className="bg-paper border-hairline z-40 hidden w-64 shrink-0 border-r lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:overflow-y-auto">
        <SidebarContents
          isOfficer={isOfficer}
          name={name}
          email={email}
          signOut={signOut}
          pathname={pathname}
        />
      </aside>
    </>
  );
}

function Brand() {
  return (
    <Link href="/" className="inline-flex min-h-11 shrink-0 items-center">
      <Wordmark tone="dark" />
    </Link>
  );
}

export function SidebarContents({
  isOfficer,
  name,
  email,
  signOut,
  pathname,
  onNavigate,
}: SidebarProps & {
  pathname: string;
  /** Closes the mobile sheet, including on a link to the page already open. */
  onNavigate?: () => void;
}) {
  // Derived from the URL, so a link is the whole switch: no cookie, no state.
  const officerView = isOfficer && isOfficerPath(pathname);
  const links = officerView ? adminNav : portalNav;

  // Longest matching href wins, so a nested route lights one link rather than
  // putting aria-current="page" on itself and on its parent.
  let activeHref = "";
  for (const link of links) {
    const matches =
      pathname === link.href || pathname.startsWith(`${link.href}/`);
    if (matches && link.href.length > activeHref.length) activeHref = link.href;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 px-4 py-4">
      <div className="hidden lg:block">
        <Brand />
      </div>

      {isOfficer && (
        <div
          role="group"
          aria-label="View"
          className="border-hairline grid grid-cols-2 rounded-lg border p-1"
        >
          {[
            { href: "/portal/admin", label: "Officer", selected: officerView },
            { href: "/portal", label: "Member", selected: !officerView },
          ].map((view) => (
            <Link
              key={view.href}
              href={view.href}
              onClick={onNavigate}
              aria-current={view.selected ? "true" : undefined}
              className={cn(
                "text-body-sm flex min-h-11 items-center justify-center rounded-md font-semibold",
                view.selected
                  ? "bg-navy text-white"
                  : "text-ink-muted hover:text-navy",
              )}
            >
              {view.label}
            </Link>
          ))}
        </div>
      )}

      <nav aria-label="Portal">
        <ul role="list" className="grid gap-1">
          {links.map((link) => {
            const active = link.href === activeHref;

            return (
              <li key={link.href}>
                {/* "page" only on an exact match: on a detail route the
                    breadcrumb is the current page, and this link is not. */}
                <Link
                  href={link.href}
                  onClick={onNavigate}
                  aria-current={
                    !active
                      ? undefined
                      : pathname === link.href
                        ? "page"
                        : "true"
                  }
                  className={cn(
                    "text-body-sm relative flex min-h-11 items-center rounded-md px-3 font-medium",
                    active
                      ? "text-navy bg-cream after:bg-gold-bright font-semibold after:absolute after:inset-y-2 after:left-0 after:w-0.5"
                      : "text-ink-muted hover:text-navy hover:bg-cream",
                  )}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-hairline mt-auto grid gap-1 border-t pt-4">
        <p className="text-ink-muted text-body-sm truncate px-3">
          {name ?? email}
        </p>
        {signOut}
      </div>
    </div>
  );
}
