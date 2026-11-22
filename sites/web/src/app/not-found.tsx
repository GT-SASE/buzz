import {
  NotFoundBody,
  notFoundMetadata,
} from "~/components/site/not-found-body";
import { SiteFooter } from "~/components/site/site-footer";
import { SiteNav } from "~/components/site/site-nav";

export const metadata = notFoundMetadata;

/**
 * Global 404 for URLs that match no route, so it runs under the root layout
 * alone and mounts the public chrome itself. A notFound() thrown inside
 * (marketing) renders (marketing)/not-found.tsx instead.
 */
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
        <NotFoundBody />
      </main>
      <SiteFooter dino={false} />
    </>
  );
}
