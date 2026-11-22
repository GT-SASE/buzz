"use client";

import { useEffect } from "react";

// A boundary file ships in every page's JS whether or not anything throws, and
// loading the panel lazily does not help: Next still fetches its chunks. So
// this is plain markup. It is the Alert and Button this panel used, with their
// classes written out, because importing them brought tailwind-merge, cva,
// Slot and lucide (~50 kB decoded) into every marketing page.
// tests/public-bundle.test.ts keeps those imports out.
const button =
  "inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-auto";

/**
 * Marketing segment boundary. Kept chrome-less: the route-group layout already
 * mounts nav/footer, so this is just a centered panel.
 */
export default function MarketingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Marketing render failed:", error);
  }, [error]);

  return (
    <section className="bg-cream flex min-h-[50vh] items-center px-5 py-20 sm:px-6">
      <div className="border-hairline bg-paper mx-auto w-full max-w-lg rounded-lg border p-8 sm:p-10">
        <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
          This page could not load.
        </h1>

        <div
          role="alert"
          data-slot="alert"
          className="text-destructive bg-card border-destructive/30 *:data-[slot=alert-description]:text-destructive/90 relative mt-6 grid w-full grid-cols-[calc(var(--spacing)*4)_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </svg>
          <div
            data-slot="alert-title"
            className="col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight"
          >
            Something went wrong
          </div>
          <div
            data-slot="alert-description"
            className="text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed"
          >
            <p>This is usually temporary. Try again in a moment.</p>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button
            type="button"
            onClick={reset}
            className={`${button} bg-gold-bright text-navy hover:bg-gold`}
          >
            Try again
          </button>
          {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- full reload on purpose: the tree that threw is discarded */}
          <a
            href="/"
            className={`${button} border-hairline bg-background text-navy hover:bg-cream border shadow-xs`}
          >
            Back to home
          </a>
        </div>

        {error.digest && (
          <p className="text-ink-muted/80 mt-6 font-mono text-xs">
            Reference {error.digest}
          </p>
        )}
      </div>
    </section>
  );
}
