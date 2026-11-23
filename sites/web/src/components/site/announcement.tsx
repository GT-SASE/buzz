import { X } from "lucide-react";
import Link from "next/link";

import {
  ANNOUNCEMENT_ELEMENT_ID,
  announcementScript,
  type Announcement,
} from "~/lib/announcement";

const linkClass =
  "text-gold-bright hover:text-white font-semibold underline decoration-2 underline-offset-4 transition";

/**
 * The officers' site-wide notice, above the nav on every public page.
 *
 * Server markup only, so it ships no JavaScript. It is in the prerendered HTML,
 * which keeps it from shifting the page when it arrives. Dismissal is the
 * inline script below the banner: it runs before the first paint, so a visitor
 * who already dismissed this version never sees it flash and nothing moves.
 * `suppressHydrationWarning` covers the attributes that script sets.
 */
export function AnnouncementBanner({
  announcement,
}: {
  announcement: Announcement;
}) {
  const { message, link, version } = announcement;

  return (
    <>
      <section
        id={ANNOUNCEMENT_ELEMENT_ID}
        aria-label="Announcement"
        data-version={version}
        suppressHydrationWarning
        className="bg-navy text-white"
      >
        <div className="max-w-content mx-auto flex items-start gap-3 px-5 sm:items-center sm:px-6">
          <p className="text-body-sm flex-1 py-3 leading-snug">
            {message}
            {link && (
              <>
                {" "}
                {link.href.startsWith("/") ? (
                  <Link href={link.href} className={linkClass}>
                    {link.label}
                  </Link>
                ) : (
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClass}
                  >
                    {link.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                )}
              </>
            )}
          </p>
          <button
            type="button"
            data-dismiss
            hidden
            suppressHydrationWarning
            aria-label="Dismiss announcement"
            className="hover:bg-navy-deep -mr-3 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-white/80 transition hover:text-white"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
      </section>
      <script dangerouslySetInnerHTML={{ __html: announcementScript }} />
    </>
  );
}
