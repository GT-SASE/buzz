import Link from "next/link";

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { tierFor } from "~/data/portal";
import type { RouterOutputs } from "~/trpc/react";

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted px-0 font-semibold uppercase";

function Board({
  children,
  heading,
}: {
  children: React.ReactNode;
  heading: boolean;
}) {
  return (
    <section className={heading ? "mt-12" : "mt-6"}>
      {heading && (
        <h2 className="text-eyebrow tracking-caps text-ink-muted border-hairline border-b pb-3 font-semibold uppercase">
          Leaderboard
        </h2>
      )}
      {children}
    </section>
  );
}

/** Who a row is shown as. A hidden name is never in the payload. */
function displayName(row: { name: string | null; isYou: boolean }) {
  if (row.name) return row.name;
  return row.isYou ? "You (name hidden)" : "Anonymous member";
}

function Standing({
  rank,
  name,
  totalPoints,
  totalEvents,
  isYou,
  pinned = false,
}: {
  rank: number;
  name: string;
  totalPoints: number;
  totalEvents: number;
  isYou: boolean;
  /** Below the visible top N, under its own divider. */
  pinned?: boolean;
}) {
  const rankName = tierFor(totalPoints).name;

  return (
    <TableRow
      className={cn(
        isYou && "bg-cream hover:bg-cream",
        // On the cells, not the row: TableBody carries
        // `[&_tr:last-child]:border-0`, which outranks a border set here and
        // the pinned row is always last.
        pinned && "[&>td]:border-rule [&>td]:border-t-2",
      )}
    >
      <TableCell className="text-gold-ink px-0 py-4 font-bold tabular-nums">
        {rank}
      </TableCell>
      <TableCell
        className={cn(
          "text-navy px-0 py-4 whitespace-normal",
          isYou ? "font-bold" : "font-medium",
        )}
      >
        {isYou && !pinned && <span className="sr-only">Your rank. </span>}
        {name}
        <span className="text-ink-muted mt-0.5 block text-xs font-medium tracking-wide uppercase">
          {rankName}
        </span>
      </TableCell>
      <TableCell className="text-ink-muted text-body-sm px-0 py-4 text-right tabular-nums">
        {totalEvents}
      </TableCell>
      <TableCell
        className={cn(
          "text-navy px-0 py-4 text-right tabular-nums",
          isYou ? "font-bold" : "font-semibold",
        )}
      >
        {totalPoints}
      </TableCell>
    </TableRow>
  );
}

/** `null` means the board failed to load. */
export function Leaderboard({
  data,
  heading = true,
  emptyMessage,
  footer,
}: {
  data: RouterOutputs["member"]["leaderboard"] | null;
  /** Off where the page already titles the board. */
  heading?: boolean;
  /** Shown when nobody has points; without it an empty board renders nothing. */
  emptyMessage?: string;
  footer?: React.ReactNode;
}) {
  if (!data) {
    return (
      <Board heading={heading}>
        <p className="text-ink-muted text-body-sm mt-4">
          Leaderboard could not be loaded. Refresh and try again.
        </p>
      </Board>
    );
  }

  const { top, you } = data;

  // Nobody has checked in anywhere yet. An empty board is worse than none.
  if (top.length === 0) {
    if (!emptyMessage) return null;
    return (
      <Board heading={heading}>
        <p className="text-ink-muted text-body-sm mt-4">{emptyMessage}</p>
        {footer}
      </Board>
    );
  }

  const pinned = you && !top.some((row) => row.isYou) ? you : null;

  return (
    <Board heading={heading}>
      <ul className="mt-4 grid gap-3 md:hidden">
        {top.map((row) => (
          <li
            key={row.rank}
            className={cn(
              "border-hairline flex items-baseline justify-between gap-3 rounded-lg border px-4 py-3",
              row.isYou && "bg-cream",
            )}
          >
            <p className="min-w-0">
              <span className="text-gold-ink font-bold tabular-nums">
                {row.rank}
              </span>
              <span
                className={cn(
                  "text-navy ml-3",
                  row.isYou ? "font-bold" : "font-medium",
                )}
              >
                {row.isYou && row.name ? `${row.name} (you)` : displayName(row)}
                <span className="text-ink-muted ml-2 text-xs font-medium tracking-wide uppercase">
                  {tierFor(row.totalPoints).name}
                </span>
              </span>
            </p>
            <p className="text-navy shrink-0 font-semibold tabular-nums">
              {row.totalPoints}
            </p>
          </li>
        ))}
        {pinned && (
          <li className="border-rule bg-cream flex items-baseline justify-between gap-3 rounded-lg border-t-2 px-4 py-3">
            <p className="min-w-0">
              <span className="text-gold-ink font-bold tabular-nums">
                {pinned.rank}
              </span>
              <span className="text-navy ml-3 font-bold">You</span>
            </p>
            <p className="text-navy shrink-0 font-semibold tabular-nums">
              {pinned.totalPoints}
            </p>
          </li>
        )}
      </ul>

      <div className="hidden md:block">
        <Table label="Chapter leaderboard">
          <TableCaption className="sr-only">
            Members ranked by the points they have earned.
          </TableCaption>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(columnHeading, "w-12")}>Rank</TableHead>
              <TableHead className={columnHeading}>Member</TableHead>
              <TableHead className={cn(columnHeading, "text-right")}>
                Events
              </TableHead>
              <TableHead className={cn(columnHeading, "text-right")}>
                Points
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {top.map((row) => (
              <Standing
                key={row.rank}
                rank={row.rank}
                name={displayName(row)}
                totalPoints={row.totalPoints}
                totalEvents={row.totalEvents}
                isYou={row.isYou}
              />
            ))}
            {pinned && (
              <Standing
                rank={pinned.rank}
                name="You"
                totalPoints={pinned.totalPoints}
                totalEvents={pinned.totalEvents}
                isYou
                pinned
              />
            )}
          </TableBody>
        </Table>
      </div>

      {you === null && (
        <p className="text-ink-muted text-body-sm mt-4">
          You are not on the board yet.{" "}
          <Link
            href="/portal/check-in"
            className="text-navy inline-flex min-h-11 items-center font-semibold underline underline-offset-4"
          >
            Check in at your next event
          </Link>{" "}
          and you will appear here.
        </p>
      )}
      {footer}
    </Board>
  );
}
