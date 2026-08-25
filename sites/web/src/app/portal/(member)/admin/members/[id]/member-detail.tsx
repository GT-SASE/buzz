"use client";

import Link from "next/link";

import { EmptyState } from "~/app/portal/_components/portal-ui";
import { formatDate, formatMonth } from "~/app/portal/_lib/format";
import { Eyebrow, InitialDisc } from "~/components/site";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { tierFor } from "~/data/portal";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type HistoryRow = RouterOutputs["member"]["byId"]["history"][number];

const columnHeading =
  "text-eyebrow tracking-caps text-ink-muted h-auto py-3 font-semibold uppercase";

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Eyebrow as="dt" tone="muted" rule={false}>
        {label}
      </Eyebrow>
      <dd className="font-display text-navy text-h3 mt-2 font-bold tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function HistoryTable({ children }: { children: React.ReactNode }) {
  return (
    <Table label="Check-in history" className="min-w-[34rem] text-left">
      <TableHeader>
        <TableRow className="border-hairline">
          <TableHead className={cn(columnHeading, "w-full pr-6")}>
            Event
          </TableHead>
          <TableHead className={cn(columnHeading, "pr-6")}>Date</TableHead>
          <TableHead className={cn(columnHeading, "pr-6 text-right")}>
            Points
          </TableHead>
          <TableHead className={columnHeading}>How</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function HistoryRows({ rows }: { rows: HistoryRow[] }) {
  return (
    <>
      {rows.map((row) => (
        <TableRow key={row.eventId} className="border-hairline align-top">
          <TableCell className="py-2 pr-6 whitespace-normal">
            <Link
              href={`/portal/admin/events/${row.eventId}`}
              className="text-navy inline-flex min-h-11 items-center font-semibold hover:underline"
            >
              {row.title}
            </Link>
            {row.location && (
              <p className="text-ink-muted text-body-sm">{row.location}</p>
            )}
          </TableCell>
          <TableCell className="text-ink-muted text-body-sm py-4 pr-6 tabular-nums">
            {formatDate(row.startsAt)}
            {/* The list is ordered by check-in, not by event date, so a manual
                grant lands out of order against the column above it. This is
                also the only record of when that grant happened. */}
            {formatDate(row.checkedInAt) !== formatDate(row.startsAt) && (
              <span className="text-ink-muted/80 block">
                Checked in {formatDate(row.checkedInAt)}
              </span>
            )}
          </TableCell>
          <TableCell className="text-gold-ink py-4 pr-6 text-right font-semibold tabular-nums">
            +{row.pointsEarned}
          </TableCell>
          <TableCell className="text-ink-muted text-body-sm py-4">
            {row.method === "manual" ? "Added by an officer" : "Scanned"}
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function HistoryCards({ rows }: { rows: HistoryRow[] }) {
  return (
    <ul className="grid gap-3 md:hidden">
      {rows.map((row) => (
        <li key={row.eventId}>
          <Link
            href={`/portal/admin/events/${row.eventId}`}
            className="border-hairline block min-h-11 rounded-lg border px-4 py-4"
          >
            <p className="text-navy font-semibold">{row.title}</p>
            {row.location && (
              <p className="text-ink-muted text-body-sm mt-1">{row.location}</p>
            )}
            <p className="text-ink-muted text-body-sm mt-2 tabular-nums">
              {formatDate(row.startsAt)}
              {formatDate(row.checkedInAt) !== formatDate(row.startsAt) &&
                ` · checked in ${formatDate(row.checkedInAt)}`}
            </p>
            <p className="text-gold-ink text-body-sm mt-2 font-semibold tabular-nums">
              +{row.pointsEarned} ·{" "}
              {row.method === "manual" ? "Added by an officer" : "Scanned"}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }, (_, index) => (
        <TableRow key={index} className="border-hairline">
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-4 w-48" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="h-4 w-24" />
          </TableCell>
          <TableCell className="py-4 pr-6">
            <Skeleton className="ml-auto h-4 w-8" />
          </TableCell>
          <TableCell className="py-4">
            <Skeleton className="h-4 w-32" />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function MemberSkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading member...</span>
      <div className="flex items-start gap-5">
        <Skeleton className="size-14 shrink-0 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="mt-3 h-4 w-56" />
        </div>
      </div>
      <div className="border-hairline mt-10 grid gap-8 border-y py-8 sm:grid-cols-3">
        {[0, 1, 2].map((figure) => (
          <div key={figure}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-20" />
          </div>
        ))}
      </div>
      <div className="mt-14">
        <Skeleton className="h-6 w-48" />
      </div>
      <div className="mt-6 hidden md:block">
        <HistoryTable>
          <SkeletonRows />
        </HistoryTable>
      </div>
    </div>
  );
}

export function MemberDetail({ memberId }: { memberId: string }) {
  const utils = api.useUtils();
  const detail = api.member.byId.useQuery(
    { id: memberId },
    {
      // A stale or hand-typed id is not a transient failure, so retrying it only
      // holds the skeleton on screen for several seconds before the same answer.
      retry: (failureCount, error) =>
        error.data?.code !== "NOT_FOUND" && failureCount < 2,
    },
  );
  const revoke = api.member.revokeSessions.useMutation({
    onSuccess: async () => {
      await utils.member.byId.invalidate({ id: memberId });
    },
  });
  const promote = api.member.promote.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.member.byId.invalidate({ id: memberId }),
        utils.member.list.invalidate(),
      ]);
    },
  });

  if (detail.isPending) {
    return <MemberSkeleton />;
  }

  if (detail.error) {
    return detail.error.data?.code === "NOT_FOUND" ? (
      <div role="status">
        <EmptyState
          title="Member not found."
          body="Nobody on the roster has this link. They may have been removed since it was shared."
        >
          <Button
            asChild
            className="bg-navy hover:bg-navy-deep min-h-11 rounded-md font-semibold text-white"
          >
            <Link href="/portal/admin/members">Back to the roster</Link>
          </Button>
        </EmptyState>
      </div>
    ) : (
      <Alert variant="destructive" className="border-hairline">
        <AlertTitle>Could not load this member.</AlertTitle>
        <AlertDescription>{detail.error.message}</AlertDescription>
      </Alert>
    );
  }

  const { member, totalPoints, totalEvents, memberSince, history } =
    detail.data;

  const displayName = member.name ?? member.email;
  const tier = tierFor(totalPoints);

  return (
    <div>
      <div className="flex flex-wrap items-start gap-5">
        <InitialDisc label={displayName} />

        <div className="min-w-0 flex-1">
          <h1 className="font-display text-navy text-h2 font-bold tracking-tight text-balance">
            {displayName}
          </h1>
          <p className="text-ink-muted text-body mt-2 break-words">
            {member.email}
          </p>

          {/* Both pills read "Member" for a new member, so each says which it
              is rather than relying on colour to tell them apart. */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge
              variant={member.role === "ADMIN" ? "default" : "secondary"}
              className="text-body-sm font-semibold"
            >
              {member.role === "ADMIN" ? "Officer" : "Member"}
            </Badge>
            <Badge
              variant="outline"
              className="text-gold-ink border-gold-ink/40 text-body-sm font-semibold"
            >
              Tier: {tier.name}
            </Badge>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {member.role !== "ADMIN" && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    disabled={promote.isPending}
                    className="bg-navy hover:bg-navy-deep min-h-11 rounded-md font-semibold text-white"
                  >
                    {promote.isPending ? "Promoting..." : "Make officer"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Make {displayName} an officer?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      They will see the officer tools the next time they load
                      the portal. This does not take officer access away from
                      anyone else.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => promote.mutate({ userId: member.id })}
                    >
                      Yes, make officer
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate({ userId: member.id })}
              className="border-hairline text-navy hover:bg-cream min-h-11 rounded-md font-semibold"
            >
              {revoke.isPending
                ? "Revoking sessions..."
                : revoke.isSuccess
                  ? revoke.data.revoked === 0
                    ? "No sessions to revoke"
                    : `Revoked ${revoke.data.revoked} session${revoke.data.revoked === 1 ? "" : "s"}`
                  : "Revoke all sessions"}
            </Button>
          </div>
          {promote.error && (
            <p className="text-destructive text-body-sm mt-2">
              {promote.error.message}
            </p>
          )}
        </div>
      </div>

      <dl className="border-hairline mt-10 grid gap-8 border-y py-8 sm:grid-cols-3">
        <Figure label="Total points" value={String(totalPoints)} />
        <Figure label="Events attended" value={String(totalEvents)} />
        <Figure
          label="Member since"
          value={memberSince ? formatMonth(memberSince) : "Not yet"}
        />
      </dl>

      {tier.pointsToNext !== null && (
        <p className="text-ink-muted text-body-sm mt-4">
          <span className="tabular-nums">{tier.pointsToNext}</span> more to
          reach {tier.next}.
        </p>
      )}

      <div className="mt-14">
        <Eyebrow tone="gold">Attendance</Eyebrow>
        <h2 className="font-display text-navy text-h3 mt-4 font-bold tabular-nums">
          {totalEvents} {totalEvents === 1 ? "event" : "events"}
        </h2>
      </div>

      <div className="mt-6">
        {history.length > 0 ? (
          <>
            <HistoryCards rows={history} />
            <div className="hidden md:block">
              <HistoryTable>
                <HistoryRows rows={history} />
              </HistoryTable>
            </div>
            {history.length < totalEvents && (
              <p className="text-ink-muted text-body-sm mt-4">
                Showing the {history.length} most recent of {totalEvents}{" "}
                check-ins.
              </p>
            )}
          </>
        ) : (
          <EmptyState
            title="No check-ins yet."
            body="Every event they enter a code for lands here, with the points it earned."
          />
        )}
      </div>
    </div>
  );
}
