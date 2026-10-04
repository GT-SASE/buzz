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
import { SaseMark } from "~/components/site/hive";

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
      {/* The member's badge: same stock, strap slot and navy band as the
          one on the home page. */}
      <Card className="border-hairline bg-paper relative gap-0 overflow-hidden rounded-[1.375rem] border py-0 shadow-[0_1px_0_var(--hairline),0_18px_40px_-18px_rgb(15_31_48/0.35)]">
        <div
          aria-hidden="true"
          className="border-hairline bg-cream mx-auto mt-4 h-3 w-[4.5rem] rounded-full border"
        />
        <CardHeader className="bg-navy mt-3.5 flex items-center justify-between gap-3 px-5 py-4 text-white sm:px-6">
          <div>
            <CardTitle className="font-display text-xl leading-none font-bold">
              {site.portalName}
            </CardTitle>
            <CardDescription className="mt-1 text-[0.8125rem] text-white/75">
              {site.shortName} Member
            </CardDescription>
          </div>
          <CardAction>
            <SaseMark tile className="h-10 w-10" />
          </CardAction>
        </CardHeader>

        <CardContent className="px-5 pt-5 sm:px-6">
          <p className="text-ink-muted text-[0.8125rem] font-semibold">
            Hello, my name is
          </p>
          <p className="font-display text-navy mt-1 text-[1.75rem] leading-tight font-bold break-words">
            {name}
          </p>
          {memberSince && (
            <p className="text-ink-muted text-body-sm mt-1">
              Member since {memberSince}
            </p>
          )}
        </CardContent>

        <CardFooter className="border-sand mx-5 mt-5 mb-5 flex-wrap items-end justify-between gap-4 border-t-2 border-dashed px-0 pt-4 sm:mx-6">
          <div>
            <p className="font-display text-navy text-5xl leading-none font-bold tabular-nums">
              {totalPoints}
            </p>
            <p className="text-ink-muted text-body-sm mt-2">
              Event points · {totalEvents}{" "}
              {totalEvents === 1 ? "event" : "events"}
            </p>
          </div>
          <Badge className="bg-gold-bright text-navy max-w-full shrink rounded-full border-transparent px-3 py-1 text-[0.8125rem] font-bold whitespace-normal">
            Rank {tier.level} · {tier.name}
          </Badge>
        </CardFooter>
      </Card>

      {tier.pointsToNext !== null && (
        <div className="mt-4 px-1">
          <Progress
            value={Math.round(tier.progress * 100)}
            aria-label="Progress to the next tier"
            className="bg-sand [&_[data-slot=progress-indicator]]:bg-navy h-1"
          />
          <p className="text-ink-muted text-body-sm mt-2.5">
            {tier.pointsToNext} more to reach {tier.next}. Come back next event
            for a streak bonus.
          </p>
        </div>
      )}
    </div>
  );
}
