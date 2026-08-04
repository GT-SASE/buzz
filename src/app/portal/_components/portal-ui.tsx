import { Eyebrow } from "~/app/_components/ui";
import { tierFor } from "~/data/portal";
import { signOutOfPortal } from "./auth-actions";

/**
 * Portal masthead. Mirrors `PageHeader` on the marketing side rather than
 * inventing a second visual language for signed-in pages — same cream ground,
 * same eyebrow, same display face.
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
      <div className="max-w-content relative mx-auto flex flex-wrap items-end justify-between gap-x-10 gap-y-8 px-5 py-12 sm:px-6 sm:py-16">
        <div className="max-w-2xl">
          <Eyebrow tone="gold">{eyebrow}</Eyebrow>
          <h1 className="font-display text-navy text-h1 mt-5 font-bold tracking-tight text-balance">
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

/**
 * The points figure. Deliberately the largest thing on the dashboard — it is
 * the one number the whole feature exists to move.
 */
export function PointsSummary({
  totalPoints,
  totalEvents,
}: {
  totalPoints: number;
  totalEvents: number;
}) {
  const tier = tierFor(totalPoints);

  return (
    <div className="rounded-panel ring-hairline bg-paper shadow-soft w-full max-w-sm p-6 ring-1 sm:p-7">
      <div className="flex items-baseline justify-between gap-4">
        <Eyebrow tone="muted" rule={false} as="p">
          Chapter points
        </Eyebrow>
        <span className="bg-parchment text-navy text-eyebrow tracking-caps rounded-full px-3 py-1 font-semibold uppercase">
          {tier.name}
        </span>
      </div>

      <p className="font-display text-gold-ink text-stat mt-3 font-bold">
        {totalPoints}
      </p>
      <p className="text-ink-muted text-body-sm mt-1">
        from {totalEvents} {totalEvents === 1 ? "event" : "events"}
      </p>

      {tier.pointsToNext !== null && (
        <div className="mt-5">
          {/* Presentational only — the sentence below carries the same fact,
              so the bar itself stays out of the accessibility tree. */}
          <div
            aria-hidden="true"
            className="bg-sand h-1.5 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-gold-bright h-full rounded-full"
              style={{ width: `${Math.round(tier.progress * 100)}%` }}
            />
          </div>
          <p className="text-ink-muted text-body-sm mt-2.5">
            {tier.pointsToNext} more to reach {tier.next}.
          </p>
        </div>
      )}
    </div>
  );
}

/** "+15 pts", beside an event a member attended. */
export function PointsPill({ points }: { points: number }) {
  return (
    <span className="bg-gold-bright/20 text-gold-ink text-body-sm ring-gold/40 inline-flex shrink-0 items-center rounded-full px-3 py-1 font-semibold ring-1">
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
      <h3 className="font-display text-navy text-h3 font-bold text-balance">
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
