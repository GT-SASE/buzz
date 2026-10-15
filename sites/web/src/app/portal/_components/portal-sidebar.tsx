"use client";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { Wordmark } from "~/components/site";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";
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
  const [open, setOpen] = useState(false);

  // A link click navigates, so the pathname is the one signal that covers it
  // and the back button alike.
  const [openedAt, setOpenedAt] = useState(pathname);
  if (openedAt !== pathname) {
    setOpenedAt(pathname);
    setOpen(false);
  }

  // The sheet is lg:hidden, so one left open while the window widens would
  // keep its scroll lock with nothing on screen to dismiss.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 64rem)");
    const close = () => {
      if (desktop.matches) setOpen(false);
    };
    desktop.addEventListener("change", close);
    return () => desktop.removeEventListener("change", close);
  }, []);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* Mobile: a top bar with the menu in a sheet. */}
      <header className="border-gold bg-paper sticky top-0 z-40 border-b-2 pt-[env(safe-area-inset-top)] lg:hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6">
          <Brand />
          <SheetTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-ink-muted hover:text-navy hover:bg-cream text-body-sm min-h-11 rounded-md font-semibold"
            >
              <Menu aria-hidden="true" className="size-4" />
              Menu
            </Button>
          </SheetTrigger>
        </div>
      </header>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="bg-paper border-hairline z-50 w-72 max-w-[85vw] gap-0 overflow-y-auto pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden"
      >
        <SheetTitle className="sr-only">Portal menu</SheetTitle>
        <div className="flex items-center justify-between px-4">
          <Brand />
          <SheetClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close menu"
              className="text-navy size-11"
            >
              <X aria-hidden="true" className="size-6" />
            </Button>
          </SheetClose>
        </div>
        <SidebarContents
          isOfficer={isOfficer}
          name={name}
          email={email}
          signOut={signOut}
          pathname={pathname}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>

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
    </Sheet>
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
