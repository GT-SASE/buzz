import type { Metadata } from "next";

import { Button, SaseDino } from "~/components/site";

export const notFoundMetadata: Metadata = {
  title: "Page not found",
  robots: { index: false },
};

/**
 * The 404 content, with no chrome. Two not-found files render it: the root one
 * wraps it in the public nav and footer for URLs that match no route, and
 * (marketing)'s renders it bare because that layout already supplies them.
 */
export function NotFoundBody() {
  return (
    <section className="flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
      <div className="max-w-content mx-auto w-full">
        {/* gold-ink, not gold: real text at display size, not decoration. */}
        <div className="flex items-end justify-between gap-6">
          <p className="font-display text-gold-ink text-hero font-bold">404</p>
          <SaseDino className="h-28 sm:h-40" />
        </div>
        <div className="rule-heavy mt-10 grid gap-x-16 gap-y-6 pt-8 lg:grid-cols-[1.35fr_1fr] lg:items-end">
          <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
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
  );
}
