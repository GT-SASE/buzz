import { tierFor } from "~/data/portal";
import { site } from "~/data/site";
import { Honeycomb } from "./honeycomb";

/**
 * The chapter membership card.
 *
 * Built to read as an object rather than a dashboard tile: card proportions, a
 * honeycomb watermark, an inset hairline where a real card would be die-cut,
 * and a foil band carrying the tier. It is the one thing on the portal worth
 * showing someone, so it is the only element allowed this much decoration —
 * everything around it stays plain on purpose.
 */
export function MemberCard({
  name,
  memberSince,
  totalPoints,
  totalEvents,
}: {
  name: string;
  memberSince: string | null;
  totalPoints: number;
  totalEvents: number;
}) {
  const tier = tierFor(totalPoints);

  return (
    <div className="w-full max-w-[26rem]">
      <div className="rounded-panel bg-parchment ring-gold/35 shadow-lift relative overflow-hidden ring-1">
        {/* Watermark. Well under the 3:1 the tier band needs, because nothing
            on top of it is a control — it is texture, not information. */}
        <Honeycomb className="text-gold-ink/[0.09] absolute inset-0 h-full w-full" />

        {/* The die-cut. A single inset hairline is what separates a card from a
            rounded rectangle. */}
        <div
          aria-hidden="true"
          className="ring-gold-ink/15 pointer-events-none absolute inset-3 rounded-[1.4rem] ring-1"
        />

        <div className="relative flex min-h-[15.5rem] flex-col justify-between p-7 sm:p-8">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-display text-navy text-lg font-bold leading-none tracking-tight">
                {site.theme}
              </p>
              <p className="text-eyebrow tracking-caps text-gold-ink mt-2 font-semibold uppercase">
                {site.shortName} Member
              </p>
            </div>
            <span className="bg-navy text-gold-bright font-display grid h-11 w-11 shrink-0 place-items-center rounded-full text-xs font-bold">
              GT
            </span>
          </div>

          <div className="mt-8">
            <p className="font-display text-navy text-xl font-bold tracking-tight">
              {name}
            </p>
            {memberSince && (
              <p className="text-eyebrow tracking-caps text-ink-muted mt-1.5 font-semibold uppercase">
                Member since {memberSince}
              </p>
            )}
          </div>

          <div className="mt-8 flex items-end justify-between gap-5">
            <div>
              <p className="font-display text-navy text-5xl font-bold tabular-nums leading-none">
                {totalPoints}
              </p>
              <p className="text-eyebrow tracking-caps text-ink-muted mt-2 font-semibold uppercase">
                Points · {totalEvents} {totalEvents === 1 ? "event" : "events"}
              </p>
            </div>

            {/* Foil. A flat gold fill reads as a coloured pill; the sheen is
                what makes it look stamped on. */}
            <span className="text-navy rounded-full bg-[linear-gradient(105deg,#b3a369_0%,#eaaa00_20%,#fff2c0_34%,#eaaa00_48%,#b3a369_72%,#d9c98d_100%)] px-4 py-1.5 text-xs font-bold uppercase tracking-[0.18em] shadow-[inset_0_1px_0_rgb(255_255_255/0.45)]">
              {tier.name}
            </span>
          </div>
        </div>
      </div>

      {tier.pointsToNext !== null && (
        <div className="mt-4 px-1">
          <div
            aria-hidden="true"
            className="bg-sand h-1 w-full overflow-hidden rounded-full"
          >
            <div
              className="bg-gold-ink/70 h-full rounded-full"
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
