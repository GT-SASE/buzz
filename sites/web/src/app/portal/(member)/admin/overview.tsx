"use client";

import Link from "next/link";

import { formatEventTime } from "~/app/portal/_lib/format";
import { Eyebrow } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type ChapterOverview = RouterOutputs["chapter"]["overview"];
type NextEvent = NonNullable<ChapterOverview["nextEvent"]>;

const figureGrid = "grid gap-8 sm:grid-cols-2 lg:grid-cols-4";

function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <Eyebrow as="dt" tone="muted" rule={false}>
        {label}
      </Eyebrow>
      <dd className="mt-3">
        <span className="font-display text-navy text-h2 block font-bold tabular-nums">
          {value}
        </span>
        <span className="text-ink-muted text-body-sm mt-2 block tabular-nums">
          {note}
        </span>
      </dd>
    </div>
  );
}

function NextUp({ event }: { event: NextEvent | null }) {
  if (!event) {
    return (
      <p className="border-hairline text-ink-muted text-body-sm mt-8 border-t pt-6">
        No upcoming events. Create one below and the next one appears here.
      </p>
    );
  }

  return (
    <div className="border-hairline mt-8 border-t pt-6">
      <Eyebrow tone="gold">Next up</Eyebrow>

      <Link
        href={`/portal/admin/events/${event.id}`}
        className="font-display text-navy text-h3 mt-2 inline-flex min-h-11 items-center font-bold hover:underline"
      >
        {event.title}
      </Link>

      <p className="text-ink-muted text-body tabular-nums">
        {formatEventTime(event.startsAt)}
        {event.location ? ` · ${event.location}` : ""}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Badge variant={event.checkInEnabled ? "default" : "outline"}>
          {event.checkInEnabled ? "Check-in open" : "Check-in closed"}
        </Badge>
        <p className="text-ink-muted text-body-sm tabular-nums">
          {event.currentCheckIns}
          {event.maxCheckIns !== null ? ` of ${event.maxCheckIns}` : ""} checked
          in
        </p>
      </div>
    </div>
  );
}

function Figures({ data }: { data: ChapterOverview }) {
  const { members, checkIns, events, nextEvent } = data;

  // Four zeroes and an empty "next up" describe a broken screen, not a chapter
  // that has not run anything yet.
  if (events.total === 0) {
    return (
      <>
        <p className="font-display text-navy text-h3 font-bold">
          No events yet.
        </p>
        <p className="text-ink-muted text-body max-w-measure mt-3">
          Attendance figures appear here once the first event is on the
          calendar. <span className="tabular-nums">{members.total}</span>{" "}
          {members.total === 1 ? "member has" : "members have"} signed in to the
          portal so far.
        </p>
      </>
    );
  }

  const attendanceNote =
    events.past === 0
      ? "No past events yet"
      : `across ${events.past} past ${events.past === 1 ? "event" : "events"}`;

  return (
    <>
      <dl className={figureGrid}>
        <Figure
          label="Members"
          value={String(members.total)}
          note={`${members.withCheckIns} ${members.withCheckIns === 1 ? "has" : "have"} checked in`}
        />
        <Figure
          label="Check-ins"
          value={String(checkIns.total)}
          note={`${checkIns.last30Days} in the last 30 days`}
        />
        <Figure
          label="Events"
          value={String(events.total)}
          note={`${events.upcoming} upcoming`}
        />
        {/* Already one decimal from the server; toFixed keeps the trailing zero
            so the figure does not change shape week to week. */}
        <Figure
          label="Average attendance"
          value={events.averageAttendance.toFixed(1)}
          note={attendanceNote}
        />
      </dl>

      <NextUp event={nextEvent} />
    </>
  );
}

function OverviewSkeleton() {
  return (
    <>
      <p className="sr-only">Loading chapter figures.</p>
      <div aria-hidden="true">
        <div className={figureGrid}>
          {[0, 1, 2, 3].map((figure) => (
            <div key={figure}>
              <Skeleton className="h-3 w-28" />
              <Skeleton className="mt-4 h-10 w-24" />
              <Skeleton className="mt-3 h-3 w-32" />
            </div>
          ))}
        </div>
        <div className="border-hairline mt-8 border-t pt-6">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-6 w-64 max-w-full" />
          <Skeleton className="mt-3 h-3 w-48 max-w-full" />
        </div>
      </div>
    </>
  );
}

/** The chapter, in figures. Sits above the events table and never blocks it. */
export function Overview() {
  const overview = api.chapter.overview.useQuery();

  return (
    <section
      aria-labelledby="chapter-overview-heading"
      className="border-hairline border-b"
    >
      <div className="max-w-content mx-auto px-5 py-10 sm:px-6 sm:py-12">
        <h2
          id="chapter-overview-heading"
          className="text-eyebrow tracking-caps text-ink-muted border-hairline border-b pb-3 font-semibold uppercase"
        >
          Chapter at a glance
        </h2>

        {/* One live region that outlives every state, so the figures landing
            after the skeleton are actually announced. */}
        <div aria-live="polite" aria-busy={overview.isPending} className="mt-6">
          {/* Data, if there is any, outranks the error: a failed background
              refetch should not wipe figures that are still in cache. */}
          {overview.data ? (
            <Figures data={overview.data} />
          ) : overview.error ? (
            <p className="text-ink-muted text-body-sm">
              Chapter figures are unavailable right now. The events below are
              unaffected.
            </p>
          ) : (
            <OverviewSkeleton />
          )}
        </div>
      </div>
    </section>
  );
}
