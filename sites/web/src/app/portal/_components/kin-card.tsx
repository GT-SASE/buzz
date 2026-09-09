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
import { HexMark } from "~/components/site/hive";
import { mentorshipTierFor } from "~/data/portal";
import { Honeycomb } from "./honeycomb";

/**
 * KIN points live on this card, not on the event membership card. Navy so
 * the two objects cannot be read as the same ledger.
 */
export function KinCard({
  name,
  role,
  points,
}: {
  name: string;
  role: "mentor" | "mentee";
  points: number;
}) {
  const tier = mentorshipTierFor(points);

  return (
    <div className="w-full max-w-[26rem]">
      <Card className="bg-navy ring-gold-bright/25 relative min-h-[15.5rem] justify-between gap-0 overflow-hidden rounded-2xl border-0 py-0 shadow-[0_2px_4px_rgb(10_22_40/0.2),0_24px_48px_-28px_rgb(10_22_40/0.55)] ring-1">
        <Honeycomb className="text-gold-bright/[0.12] absolute inset-0 h-full w-full" />

        <div
          aria-hidden="true"
          className="ring-gold-bright/20 pointer-events-none absolute inset-3 rounded-[1.4rem] ring-1"
        />

        <CardHeader className="relative px-5 pt-6 sm:px-8 sm:pt-8">
          <CardTitle className="font-display text-lg leading-none font-bold tracking-tight text-white">
            SASE KIN
          </CardTitle>
          <CardDescription className="text-eyebrow tracking-caps text-gold-bright font-semibold uppercase">
            {role === "mentor" ? "Mentor" : "Mentee"}
          </CardDescription>
          <CardAction>
            <HexMark className="bg-gold-bright text-navy h-11 w-11 text-xs" />
          </CardAction>
        </CardHeader>

        <CardContent className="relative mt-8 px-5 sm:px-8">
          <p className="font-display text-xl font-bold tracking-tight break-words text-white">
            {name}
          </p>
          <p className="text-eyebrow tracking-caps mt-1.5 font-semibold text-white/60 uppercase">
            Separate from event points
          </p>
        </CardContent>

        <CardFooter className="relative mt-8 flex-col items-start gap-4 px-5 pb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-5 sm:px-8 sm:pb-8">
          <div>
            <p className="font-display text-gold-bright text-5xl leading-none font-bold tabular-nums">
              {points}
            </p>
            <p className="text-eyebrow tracking-caps mt-2 font-semibold text-white/60 uppercase">
              KIN points
            </p>
          </div>

          <Badge className="text-navy max-w-full shrink border-transparent bg-gold-bright px-4 py-1.5 text-xs font-bold tracking-[0.12em] whitespace-normal uppercase sm:tracking-[0.18em]">
            {tier.name}
          </Badge>
        </CardFooter>
      </Card>

      {tier.pointsToNext !== null && (
        <div className="mt-4 px-1">
          <Progress
            value={Math.round(tier.progress * 100)}
            aria-label="Progress to the next KIN rank"
            className="bg-navy/20 [&_[data-slot=progress-indicator]]:bg-gold-ink/70 h-1"
          />
          <p className="text-ink-muted text-body-sm mt-2.5">
            {tier.pointsToNext} more KIN points to reach {tier.next}. Meetings
            only — GBMs do not count here.
          </p>
        </div>
      )}
    </div>
  );
}
