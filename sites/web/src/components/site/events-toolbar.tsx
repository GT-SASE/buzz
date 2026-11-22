import Link from "next/link";

import { feedUrl, webcalUrl } from "~/lib/events-feed";
import { cn } from "~/lib/utils";

const linkClass =
  "text-navy decoration-gold hover:text-gold-ink inline-flex min-h-11 items-center font-semibold underline decoration-2 underline-offset-4 transition";

/**
 * The strip under the /events header: list or month, and the subscribable
 * feed. Plain links all the way down. The view is a page, not client state, so
 * both views prerender, work without JavaScript, and can be shared.
 */
export function EventsToolbar({
  view,
  monthHref,
}: {
  view: "list" | "month";
  /** The month page the "Month" link opens. */
  monthHref: string;
}) {
  const views = [
    { id: "list", label: "List", href: "/events" },
    { id: "month", label: "Month", href: monthHref },
  ] as const;

  return (
    <div className="mb-10 flex flex-wrap items-center justify-between gap-x-10 gap-y-3">
      <nav aria-label="Calendar view">
        <ul
          role="list"
          className="border-hairline inline-flex rounded-full border p-1"
        >
          {views.map((item) => {
            const current = item.id === view;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "text-body-sm inline-flex min-h-11 min-w-20 items-center justify-center rounded-full px-5 font-semibold transition",
                    current ? "bg-navy text-white" : "text-navy hover:bg-cream",
                  )}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <p className="text-ink-muted text-body-sm flex flex-wrap items-center gap-x-5">
        <span>Subscribe to the calendar</span>
        <a href={webcalUrl} className={linkClass}>
          Calendar app
        </a>
        <a href={feedUrl} className={linkClass}>
          Feed link (.ics)
        </a>
      </p>
    </div>
  );
}
