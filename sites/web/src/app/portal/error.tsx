"use client";

import { TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "~/components/ui/card";

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
    <section className="bg-cream paper-wash flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
      <Card className="border-hairline bg-paper mx-auto w-full max-w-lg rounded-lg">
        <CardHeader>
          <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
            Sign-in could not load.
          </h1>
        </CardHeader>

        <CardContent>
          <Alert variant="destructive" className="border-destructive/30">
            <TriangleAlert />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              <p>
                This is usually temporary. Nothing about your account has
                changed — try again, or come back in a minute.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>

        <CardFooter className="flex-col items-start gap-6">
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Button
              type="button"
              onClick={reset}
              className="bg-gold-bright text-navy hover:bg-gold min-h-11 w-full rounded-none font-semibold sm:w-auto"
            >
              Try again
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-hairline text-navy hover:bg-cream min-h-11 w-full rounded-none font-semibold sm:w-auto"
            >
              <a href="/">Back to the site</a>
            </Button>
          </div>

          {error.digest && (
            <p className="text-ink-muted/80 font-mono text-xs">
              Reference {error.digest}
            </p>
          )}
        </CardFooter>
      </Card>
    </section>
  );
}
