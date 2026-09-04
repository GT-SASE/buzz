"use client";

import { Eyebrow } from "~/components/site";
import { Skeleton } from "~/components/ui/skeleton";
import { api, type RouterOutputs } from "~/trpc/react";

type ChapterOverview = RouterOutputs["chapter"]["overview"];
const figureGrid = "grid gap-4 sm:grid-cols-2 lg:grid-cols-4";

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
    <div className="border-hairline bg-paper/80 shadow-xs hover:border-gold-ink/30 flex flex-col justify-between rounded-xl border p-5 transition-all">
      <Eyebrow as="dt" tone="muted" rule={false} className="text-xs uppercase tracking-wider text-ink-muted font-semibold">
        {label}
      </Eyebrow>
      <dd className="mt-4">
        <span className="font-display text-navy text-3xl font-bold tabular-nums tracking-tight block sm:text-4xl">
          {value}
        </span>
        <span className="text-ink-muted text-body-sm mt-1.5 block tabular-nums">
          {note}
        </span>
      </dd>
    </div>
  );
}

function Figures({ data }: { data: ChapterOverview }) {
  const { members, checkIns, events } = data;

  // Four zeroes describe a broken screen, not a chapter that has not run
  // anything yet.
  if (events.total === 0) {
    return (
      <div className="border-hairline bg-paper rounded-xl border p-6">
        <p className="font-display text-navy text-h3 font-bold">
          No events yet.
        </p>
        <p className="text-ink-muted text-body max-w-measure mt-3">
          Attendance figures appear here once the first event is on the
          calendar. <span className="tabular-nums font-semibold text-navy">{members.total}</span>{" "}
          {members.total === 1 ? "member has" : "members have"} signed in to the
          portal so far.
        </p>
      </div>
    );
  }

  const attendanceNote =
    events.past === 0
      ? "No past events yet"
      : `across ${events.past} past ${events.past === 1 ? "event" : "events"}`;

  return (
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
  );
}

function OverviewSkeleton() {
  return (
    <>
      <p className="sr-only">Loading chapter figures.</p>
      <div aria-hidden="true">
        <div className={figureGrid}>
          {[0, 1, 2, 3].map((figure) => (
            <div key={figure} className="border-hairline bg-paper/50 rounded-xl border p-5">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="mt-4 h-9 w-20" />
              <Skeleton className="mt-2.5 h-3.5 w-32" />
            </div>
          ))}
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
      className="border-hairline border-b bg-cream/30"
    >
      <div className="max-w-content mx-auto px-5 py-8 sm:px-6 sm:py-10">
        <div className="mb-6 flex items-center justify-between">
          <h2
            id="chapter-overview-heading"
            className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
          >
            Chapter at a glance
          </h2>
        </div>

        {/* One live region that outlives every state, so the figures landing
            after the skeleton are actually announced. */}
        <div aria-live="polite" aria-busy={overview.isPending}>
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
