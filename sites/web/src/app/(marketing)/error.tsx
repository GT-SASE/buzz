"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

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
    <section className="bg-cream paper-wash flex min-h-[50vh] items-center px-5 py-20 sm:px-6">
      <div className="border-hairline bg-paper mx-auto w-full max-w-lg rounded-lg border p-8 sm:p-10">
        <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
          This page could not load.
        </h1>

        <Alert variant="destructive" className="border-destructive/30 mt-6">
          <TriangleAlert />
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            <p>This is usually temporary. Try again in a moment.</p>
          </AlertDescription>
        </Alert>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          <Button
            type="button"
            onClick={reset}
            className="bg-gold-bright text-navy hover:bg-gold min-h-11 w-full rounded-md font-semibold sm:w-auto"
          >
            Try again
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-hairline text-navy hover:bg-cream min-h-11 w-full rounded-md font-semibold sm:w-auto"
          >
            <a href="/">Back to home</a>
          </Button>
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
