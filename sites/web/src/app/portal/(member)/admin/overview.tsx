"use client";

import {
  Figure,
  figureGrid,
  FigureSkeletons,
} from "~/app/portal/_components/figures";
import { api, type RouterOutputs } from "~/trpc/react";

type ChapterOverview = RouterOutputs["chapter"]["overview"];

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
          calendar.{" "}
          <span className="text-navy font-semibold tabular-nums">
            {members.total}
          </span>{" "}
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
        label="Avg. attendance"
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
        <FigureSkeletons />
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
      className="border-hairline bg-cream/30 border-b"
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
