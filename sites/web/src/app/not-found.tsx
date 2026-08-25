import { Button } from "~/components/site";
import { SiteFooter } from "~/components/site/site-footer";
import { SiteNav } from "~/components/site/site-nav";

/** Global 404: outside (marketing), so it mounts the public chrome itself. */
export default function NotFound() {
  return (
    <>
      <a
        href="#content"
        className="focus:bg-navy sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:px-5 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      <SiteNav />
      <main
        id="content"
        tabIndex={-1}
        className="flex-1 focus:shadow-none focus:outline-none"
      >
        <section className="flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
          <div className="max-w-content mx-auto w-full">
            {/* gold-ink, not gold: real text at display size, not decoration. */}
            <p className="font-display text-gold-ink text-hero optical-left font-bold">
              404
            </p>
            <div className="rule-heavy mt-10 grid gap-x-16 gap-y-6 pt-8 lg:grid-cols-[1.35fr_1fr] lg:items-end">
              <h1 className="font-display text-navy text-h2 optical-left font-bold tracking-tight text-balance">
                This page took the Tech Trolley somewhere else.
              </h1>
              <p className="text-lead text-ink-muted max-w-measure lg:pb-2">
                The link may be outdated. Try the calendar or head back to the
                homepage.
              </p>
            </div>
            <div className="mt-12 flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-4">
              <Button href="/" className="w-full justify-center sm:w-auto">
                Back home
              </Button>
              <Button
                href="/events"
                variant="outline"
                className="w-full justify-center sm:w-auto"
              >
                See events
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
