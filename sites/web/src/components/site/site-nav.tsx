import Link from "next/link";

import { Wordmark } from "~/components/site/brand";
import { SiteNavShell } from "~/components/site/site-nav-shell";
import { Button } from "~/components/ui/button";
import { navCta } from "~/data/site";

/**
 * The public nav. This half renders on the server: the wordmark and both Join
 * buttons are static markup, so they stay out of the client bundle and reach
 * the interactive shell as slots.
 */
export function SiteNav() {
  return (
    <SiteNavShell
      brand={<Wordmark tone="dark" />}
      cta={
        <Button
          asChild
          className="text-body-sm bg-navy hover:bg-navy-deep h-auto rounded-full px-5 py-3 font-bold text-white [font-stretch:112%]"
        >
          <Link href={navCta.href}>{navCta.label}</Link>
        </Button>
      }
      mobileCta={
        <Button
          asChild
          className="text-body bg-navy hover:bg-navy-deep h-auto w-full rounded-full px-6 py-4 font-bold text-white [font-stretch:112%]"
        >
          <Link href={navCta.href}>{navCta.label}</Link>
        </Button>
      }
    />
  );
}
