// Plain markup for the two error boundaries that ship with public pages.
// A boundary's file loads on every page whether or not anything throws, and
// the `Alert` and `Button` it used to render pull in tailwind-merge, cva, Slot
// and lucide (~40 kB decoded). These are those components with their classes
// resolved by hand. tests/web/public-bundle.test.ts keeps the heavy imports out.

/** `Button` (default and outline variants), sized for a boundary panel. */
const errorButton =
  "inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-auto";

export const errorButtonPrimary = `${errorButton} bg-gold-bright text-navy hover:bg-gold`;

export const errorButtonOutline = `${errorButton} border border-hairline bg-background text-navy shadow-xs hover:bg-cream`;

/** `Alert variant="destructive"` with a warning icon, a title and a body. */
export function ErrorAlert({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      data-slot="alert"
      className={`text-destructive bg-card border-destructive/30 *:data-[slot=alert-description]:text-destructive/90 relative grid w-full grid-cols-[calc(var(--spacing)*4)_1fr] items-start gap-x-3 gap-y-0.5 rounded-lg border px-4 py-3 text-sm [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current ${className}`}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
      <div
        data-slot="alert-title"
        className="col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight"
      >
        Something went wrong
      </div>
      <div
        data-slot="alert-description"
        className="text-muted-foreground col-start-2 grid justify-items-start gap-1 text-sm [&_p]:leading-relaxed"
      >
        {children}
      </div>
    </div>
  );
}
