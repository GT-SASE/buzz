import { SiteFooter } from "~/components/site/site-footer";
import { SiteNav } from "~/components/site/site-nav";

/** Public chrome: everything outside /portal and /api. */
export const dynamic = "force-static";

export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      {/* Radix moves focus and marks the page inert while the mobile sheet is
          open, so skipping into content the overlay covers cannot strand
          focus — the hand-rolled inert juggling this replaces is gone. */}
      <a
        href="#content"
        className="focus:bg-navy sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:px-5 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <SiteNav />
      {/* tabIndex makes the skip link actually move focus in Safari. The global
          :focus-visible ring is two properties, so both have to go or the whole
          page picks up a gold halo on skip. */}
      <main
        id="content"
        tabIndex={-1}
        className="flex-1 focus:shadow-none focus:outline-none"
      >
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
