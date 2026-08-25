import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { tierFor } from "~/data/portal";
import { site } from "~/data/site";
import { HexMark } from "~/components/site/hive";
import { Honeycomb } from "./honeycomb";

/**
 * The chapter membership card — the one element on the portal allowed to read as
 * a physical object rather than a panel, so radius and shadow are set literally.
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
      <Card className="bg-parchment ring-gold/35 relative min-h-[15.5rem] justify-between gap-0 overflow-hidden rounded-2xl border-0 py-0 shadow-[0_2px_4px_rgb(66_48_20/0.08),0_24px_48px_-28px_rgb(66_48_20/0.45)] ring-1">
        <Honeycomb className="text-gold-ink/[0.09] absolute inset-0 h-full w-full" />

        {/* The die-cut: what separates a card from a rounded rectangle. */}
        <div
          aria-hidden="true"
          className="ring-gold-ink/15 pointer-events-none absolute inset-3 rounded-[1.4rem] ring-1"
        />

        <CardHeader className="relative px-5 pt-6 sm:px-8 sm:pt-8">
          <CardTitle className="font-display text-navy text-lg leading-none font-bold tracking-tight">
            {site.theme}
          </CardTitle>
          <CardDescription className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
            {site.shortName} Member
          </CardDescription>
          <CardAction>
            <HexMark className="h-11 w-11 text-xs" />
          </CardAction>
        </CardHeader>

        <CardContent className="relative mt-8 px-5 sm:px-8">
          <p className="font-display text-navy text-xl font-bold tracking-tight break-words">
            {name}
          </p>
          {memberSince && (
            <p className="text-eyebrow tracking-caps text-ink-muted mt-1.5 font-semibold uppercase">
              Member since {memberSince}
            </p>
          )}
        </CardContent>

        <CardFooter className="relative mt-8 flex-col items-start gap-4 px-5 pb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-5 sm:px-8 sm:pb-8">
          <div>
            <p className="font-display text-navy text-5xl leading-none font-bold tabular-nums">
              {totalPoints}
            </p>
            <p className="text-eyebrow tracking-caps text-ink-muted mt-2 font-semibold uppercase">
              Points · {totalEvents} {totalEvents === 1 ? "event" : "events"}
            </p>
          </div>

          {/* Foil, not a flat gold pill: the sheen is what makes it read stamped on. */}
          <Badge className="text-navy max-w-full shrink border-transparent bg-[linear-gradient(105deg,#b3a369_0%,#eaaa00_20%,#fff2c0_34%,#eaaa00_48%,#b3a369_72%,#d9c98d_100%)] px-4 py-1.5 text-xs font-bold tracking-[0.12em] whitespace-normal uppercase shadow-[inset_0_1px_0_rgb(255_255_255/0.45)] sm:tracking-[0.18em]">
            {tier.name}
          </Badge>
        </CardFooter>
      </Card>

      {tier.pointsToNext !== null && (
        <div className="mt-4 px-1">
          <Progress
            value={Math.round(tier.progress * 100)}
            aria-label="Progress to the next tier"
            className="bg-sand [&_[data-slot=progress-indicator]]:bg-gold-ink/70 h-1"
          />
          <p className="text-ink-muted text-body-sm mt-2.5">
            {tier.pointsToNext} more to reach {tier.next}.
          </p>
        </div>
      )}
    </div>
  );
}
