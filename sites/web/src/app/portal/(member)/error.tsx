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

/**
 * The message stays generic on purpose: `error.message` from a server component
 * is redacted in production, and a raw Postgres error tells a member nothing.
 */
export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Portal render failed:", error);
  }, [error]);

  return (
    <section className="bg-cream paper-wash flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
      <Card className="border-hairline bg-paper mx-auto w-full max-w-lg rounded-lg">
        <CardHeader>
          <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
            The portal could not load.
          </h1>
        </CardHeader>

        <CardContent>
          <Alert variant="destructive" className="border-destructive/30">
            <TriangleAlert />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>
              <p>
                This is usually temporary. Your points and attendance are stored
                on the server, so nothing has been lost.
              </p>
            </AlertDescription>
          </Alert>
        </CardContent>

        <CardFooter className="flex-col items-start gap-6">
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              onClick={reset}
              className="bg-gold-bright text-navy hover:bg-gold rounded-none font-semibold"
            >
              Try again
            </Button>
            <Button
              asChild
              variant="outline"
              className="border-hairline text-navy hover:bg-cream rounded-none font-semibold"
            >
              {/* A real navigation, not a soft one: the tree that threw is discarded. */}
              <a href="/">Back to the site</a>
            </Button>
          </div>

          {/* What an officer quotes when asking someone to check the logs. */}
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
