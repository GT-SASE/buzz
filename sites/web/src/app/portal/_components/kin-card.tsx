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
import { SaseMark } from "~/components/site/hive";
import { mentorshipTierFor } from "~/data/portal";

/**
 * KIN points live on this card, not on the event membership card. Navy so
 * the two objects cannot be read as the same ledger.
 */
export function KinCard({
  name,
  role,
  points,
  groupName,
}: {
  name: string;
  role: "mentor" | "mentee";
  points: number;
  groupName?: string | null;
}) {
  const tier = mentorshipTierFor(points);

  return (
    <div className="w-full max-w-[26rem]">
      {/* The member badge inverted: navy stock, gold band. */}
      <Card className="bg-navy relative gap-0 overflow-hidden rounded-[1.375rem] border-0 py-0 text-white shadow-[0_18px_40px_-18px_rgb(15_31_48/0.55)]">
        <div
          aria-hidden="true"
          className="mx-auto mt-4 h-3 w-[4.5rem] rounded-full bg-white/15"
        />
        <CardHeader className="bg-gold-bright text-navy mt-3.5 flex items-center justify-between gap-3 px-5 py-4 sm:px-6">
          <div>
            <CardTitle className="font-display text-xl leading-none font-bold">
              SASE KIN
            </CardTitle>
            <CardDescription className="text-navy/80 mt-1 text-[0.8125rem] font-semibold">
              {role === "mentor" ? "Mentor" : "Mentee"}
            </CardDescription>
          </div>
          <CardAction>
            <SaseMark tile className="h-10 w-10" />
          </CardAction>
        </CardHeader>

        <CardContent className="px-5 pt-5 sm:px-6">
          <p className="font-display text-[1.75rem] leading-tight font-bold break-words">
            {name}
          </p>
          <p className="text-body-sm mt-1 text-white/70">
            {groupName ?? "Separate from event points"}
          </p>
        </CardContent>

        <CardFooter className="mx-5 mt-5 mb-5 flex-wrap items-end justify-between gap-4 border-t-2 border-dashed border-white/20 px-0 pt-4 sm:mx-6">
          <div>
            <p className="font-display text-gold-bright text-5xl leading-none font-bold tabular-nums">
              {points}
            </p>
            <p className="text-body-sm mt-2 text-white/70">KIN points</p>
          </div>
          <Badge className="text-navy max-w-full shrink rounded-full border-transparent bg-white px-3 py-1 text-[0.8125rem] font-bold whitespace-normal">
            {tier.name}
          </Badge>
        </CardFooter>
      </Card>

      {tier.pointsToNext !== null && (
        <div className="mt-4 px-1">
          <Progress
            value={Math.round(tier.progress * 100)}
            aria-label="Progress to the next KIN rank"
            className="bg-sand [&_[data-slot=progress-indicator]]:bg-navy h-1"
          />
          <p className="text-ink-muted text-body-sm mt-2.5">
            {tier.pointsToNext} more KIN points to reach {tier.next}. Meetings
            only. GBMs do not count here.
          </p>
        </div>
      )}
    </div>
  );
}
