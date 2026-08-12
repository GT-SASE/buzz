import Link from "next/link";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";

/**
 * The portal's own 404. Without it a bad event or member id — a deleted event
 * still open in a tab, a mistyped roster link — falls through to the marketing
 * 404, which drops an officer out of the portal chrome and offers them the
 * public calendar rather than a way back to their tools.
 */
export default function PortalNotFound() {
  return (
    <section className="bg-cream paper-wash flex min-h-[60vh] items-center px-5 py-20 sm:px-6">
      <Card className="border-hairline bg-paper mx-auto w-full max-w-lg rounded-lg">
        <CardHeader>
          <p className="text-eyebrow tracking-masthead text-gold-ink font-semibold uppercase">
            404
          </p>
          <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight text-balance">
            That page is not in the portal.
          </h1>
        </CardHeader>

        <CardContent>
          <p className="text-ink-muted text-body-sm leading-relaxed">
            The event or member may have been removed, or the link may be out of
            date. Nothing has happened to your points or your attendance.
          </p>
        </CardContent>

        <CardFooter className="flex flex-wrap gap-3">
          <Button
            asChild
            className="bg-gold-bright text-navy hover:bg-gold rounded-none font-semibold"
          >
            <Link href="/portal">Back to your card</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-hairline text-navy hover:bg-cream rounded-none font-semibold"
          >
            <Link href="/portal/check-in">Check in</Link>
          </Button>
        </CardFooter>
      </Card>
    </section>
  );
}
