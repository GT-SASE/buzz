"use client";

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
import { api } from "~/trpc/react";

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted px-0 font-semibold uppercase";

function Board({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="text-eyebrow tracking-caps text-ink-muted border-hairline border-b pb-3 font-semibold uppercase">
        Leaderboard
      </h2>
      {children}
    </section>
  );
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

export function Leaderboard() {
  const standings = api.member.leaderboard.useQuery({ limit: 10 });

  // Nothing at all until there is something to show. Painting the heading and
  // a skeleton first would flash a phantom section on every load of a chapter
  // where nobody has checked in yet, which is exactly when it is most visible.
  // Keeping the last good data also means a failed background refetch does not
  // tear down a board that was rendering.
  const { data, error } = standings;

  if (error && !data) {
    return (
      <Board>
        <p className="text-ink-muted text-body-sm mt-4">
          Leaderboard could not be loaded. Refresh and try again.
        </p>
      </Board>
    );
  }

  if (!data) return null;

  const { top, you } = data;

  // Nobody has checked in anywhere yet. An empty board is worse than none.
  if (top.length === 0) return null;

  const pinned = you && !top.some((row) => row.isYou) ? you : null;

  return (
    <Board>
      <ul className="mt-4 grid gap-3 md:hidden">
        {top.map((row, index) => (
          <li
            key={index}
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
                {row.isYou ? `${row.name} (you)` : row.name}
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
            {top.map((row, index) => (
              <Standing
                key={index}
                rank={row.rank}
                name={row.name}
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
    </Board>
  );
}
