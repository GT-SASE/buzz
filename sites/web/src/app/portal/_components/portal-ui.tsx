import { Eyebrow } from "~/app/_components/ui";
import { signOutOfPortal } from "./auth-actions";

/**
 * Portal masthead.
 *
 * Deliberately quieter than the marketing site's `PageHeader`: on a signed-in
 * page the membership card is the thing worth looking at, so the heading gets
 * out of its way rather than competing for the same attention.
 */
export function PortalHeader({
  eyebrow,
  title,
  body,
  aside,
}: {
  eyebrow: string;
  title: string;
  body?: string;
  aside?: React.ReactNode;
}) {
  return (
    <section className="bg-cream paper-wash border-hairline relative border-b">
      <div className="max-w-content relative mx-auto grid gap-10 px-5 py-12 sm:px-6 sm:py-16 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-16">
        <div className="max-w-xl">
          <Eyebrow tone="gold">{eyebrow}</Eyebrow>
          <h1 className="font-display text-navy text-h1 mt-5 text-balance font-bold tracking-tight">
            {title}
          </h1>
          {body && (
            <p className="text-lead text-ink-muted max-w-measure mt-5">
              {body}
            </p>
          )}
        </div>
        {aside}
      </div>
    </section>
  );
}

/** "+15 pts", beside an event a member attended. */
export function PointsPill({ points }: { points: number }) {
  return (
    <span className="bg-gold-bright/20 text-gold-ink text-body-sm ring-gold/40 inline-flex shrink-0 items-center rounded-full px-3 py-1 font-semibold tabular-nums ring-1">
      +{points} pts
    </span>
  );
}

/**
 * What a portal page shows when there is nothing yet. Always carries the action
 * that fills it — an empty panel with no next step is the placeholder problem
 * in another costume.
 */
export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-panel border-hairline bg-cream border border-dashed px-6 py-14 text-center">
      <h3 className="font-display text-navy text-h3 text-balance font-bold">
        {title}
      </h3>
      <p className="text-ink-muted text-body max-w-measure mx-auto mt-3">
        {body}
      </p>
      {children && (
        <div className="mt-7 flex flex-wrap justify-center gap-4">
          {children}
        </div>
      )}
    </div>
  );
}

/** Sign out. A form post, so it works with JavaScript still loading. */
export function SignOutButton() {
  return (
    <form action={signOutOfPortal}>
      <button
        type="submit"
        className="text-ink-muted hover:text-navy text-body-sm font-semibold transition"
      >
        Sign out
      </button>
    </form>
  );
}
