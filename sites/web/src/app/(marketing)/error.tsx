"use client";

import { useEffect } from "react";

import {
  ErrorAlert,
  errorButtonOutline,
  errorButtonPrimary,
} from "~/components/site/error-alert";

/**
 * Marketing segment boundary. Kept chrome-less: the route-group layout already
 * mounts nav/footer, so this is just a centered panel. Plain markup on purpose:
 * see error-alert.tsx.
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

        <ErrorAlert className="mt-6">
          <p>This is usually temporary. Try again in a moment.</p>
        </ErrorAlert>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <button type="button" onClick={reset} className={errorButtonPrimary}>
            Try again
          </button>
          {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- full reload on purpose: the tree that threw is discarded */}
          <a href="/" className={errorButtonOutline}>
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
