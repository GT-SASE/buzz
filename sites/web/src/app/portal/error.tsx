"use client";

import { useEffect } from "react";

import {
  ErrorAlert,
  errorButtonOutline,
  errorButtonPrimary,
} from "~/components/site/error-alert";

/**
 * Portal shell boundary. Plain markup on purpose: every public page prefetches
 * the sign-in route, and this file is part of its JS. See error-alert.tsx.
 */
export default function PortalShellError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Portal shell render failed:", error);
  }, [error]);

  return (
    <section className="bg-cream flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
      <div className="text-card-foreground border-hairline bg-paper mx-auto flex w-full max-w-lg flex-col gap-6 rounded-lg border py-6 shadow-sm">
        <div className="grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6">
          <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
            Sign-in could not load.
          </h1>
        </div>

        <div className="px-6">
          <ErrorAlert>
            <p>
              This is usually temporary. Nothing about your account has changed.
              Try again, or come back in a minute.
            </p>
          </ErrorAlert>
        </div>

        <div className="flex flex-col items-start gap-6 px-6">
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap">
            <button
              type="button"
              onClick={reset}
              className={errorButtonPrimary}
            >
              Try again
            </button>
            {/* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- full reload on purpose: the tree that threw is discarded */}
            <a href="/" className={errorButtonOutline}>
              Back to the site
            </a>
          </div>

          {error.digest && (
            <p className="text-ink-muted/80 font-mono text-xs">
              Reference {error.digest}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
