"use client";

import { useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";
import { Legend, RsvpBars, TurnoutChart, TurnoutTable } from "./turnout-charts";

type Attendance = RouterOutputs["chapter"]["attendance"];
type Turnout = RouterOutputs["chapter"]["turnout"];
type Period = Attendance["period"];

const periods: { id: Period; label: string }[] = [
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "semester", label: "School year" },
  { id: "all", label: "All time" },
];

function PeriodSwitch({
  value,
  onChange,
}: {
  value: Period;
  onChange: (period: Period) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Attendance period"
      className="ring-hairline bg-cream flex flex-wrap gap-1 rounded-lg p-1 ring-1"
    >
      {periods.map((period) => {
        const selected = period.id === value;
        return (
          <button
            key={period.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(period.id)}
            className={cn(
              "min-h-9 rounded-md px-3 py-1.5 text-xs font-semibold transition-all",
              selected
                ? "bg-navy text-white shadow-xs"
                : "text-ink-muted hover:bg-paper hover:text-navy",
            )}
          >
            {period.label}
          </button>
        );
      })}
    </div>
  );
}

/** One sentence instead of a second row of tiles under the chapter figures. */
function PeriodSummary({ data }: { data: Attendance }) {
  return (
    <p className="text-ink text-body">
      <span className="font-semibold tabular-nums">{data.checkIns}</span>{" "}
      {data.checkIns === 1 ? "check-in" : "check-ins"} from{" "}
      <span className="font-semibold tabular-nums">{data.uniqueMembers}</span>{" "}
      {data.uniqueMembers === 1 ? "member" : "members"} across{" "}
      <span className="font-semibold tabular-nums">{data.events}</span>{" "}
      {data.events === 1 ? "event" : "events"}, about{" "}
      <span className="font-semibold tabular-nums">
        {data.averageAttendance.toFixed(1)}
      </span>{" "}
      per event.
    </p>
  );
}

const panel = "border-hairline bg-paper rounded-lg border p-5 shadow-xs";

function Charts({ turnout }: { turnout: Turnout }) {
  return (
    <div className="mt-6 grid gap-6">
      <section aria-labelledby="turnout-heading" className={panel}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3
            id="turnout-heading"
            className="text-navy text-body font-semibold"
          >
            Check-ins per event
          </h3>
          <Legend />
        </div>
        <div className="mt-4">
          <TurnoutChart events={turnout.events} />
        </div>
        <details className="mt-4">
          <summary className="text-navy text-body-sm cursor-pointer font-semibold">
            Show as table
          </summary>
          <div className="mt-3">
            <TurnoutTable events={turnout.events} />
          </div>
        </details>
      </section>

      <section aria-labelledby="rsvp-heading" className={panel}>
        <h3 id="rsvp-heading" className="text-navy text-body font-semibold">
          RSVPs for upcoming events
        </h3>
        <div className="mt-4">
          {turnout.upcoming.length > 0 ? (
            <RsvpBars upcoming={turnout.upcoming} />
          ) : (
            <p className="text-ink-muted text-body-sm">No upcoming events.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function AttendanceBody({
  data,
  turnout,
}: {
  data: Attendance;
  turnout: Turnout | undefined;
}) {
  if (data.events === 0) {
    return (
      <p className="text-ink-muted text-body max-w-measure mt-6">
        No countable events in this window. Campus listings without check-in
        stay off this list.
      </p>
    );
  }

  return (
    <div className="mt-6">
      <PeriodSummary data={data} />
      {turnout && <Charts turnout={turnout} />}
      {data.events > data.series.length ? (
        <p className="text-ink-muted text-body-sm mt-6 tabular-nums">
          Showing the {data.series.length} most recent of {data.events} events.
        </p>
      ) : null}
    </div>
  );
}

function AttendanceSkeleton() {
  return (
    <div aria-hidden="true" className="mt-6">
      <Skeleton className="h-5 w-3/4 max-w-lg" />
      <div className="border-hairline bg-paper/50 mt-6 rounded-lg border p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-4 h-52 w-full" />
      </div>
    </div>
  );
}

/** Attendance over a chosen window. Sits under the chapter figures. */
export function Attendance() {
  const [period, setPeriod] = useState<Period>("semester");
  const attendance = api.chapter.attendance.useQuery(
    { period },
    { placeholderData: (previous) => previous },
  );
  const turnout = api.chapter.turnout.useQuery(
    { period },
    { placeholderData: (previous) => previous },
  );

  return (
    <section
      aria-labelledby="attendance-heading"
      className="border-hairline border-b py-8 sm:py-10"
    >
      <div className="max-w-content mx-auto px-5 sm:px-6">
        <div className="border-hairline bg-paper/50 rounded-xl border p-6 sm:p-8">
          <div className="border-hairline flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2
                id="attendance-heading"
                className="font-display text-navy text-xl font-bold tracking-tight"
              >
                Attendance over time
              </h2>
              <p className="text-ink-muted text-body-sm mt-1">
                Trends and turnout across chapter events.
              </p>
            </div>
            <PeriodSwitch value={period} onChange={setPeriod} />
          </div>

          <div aria-live="polite" aria-busy={attendance.isPending}>
            {attendance.data ? (
              <AttendanceBody data={attendance.data} turnout={turnout.data} />
            ) : attendance.error ? (
              <p className="text-ink-muted text-body-sm mt-6">
                Attendance for this window is unavailable right now.
              </p>
            ) : (
              <>
                <p className="sr-only">Loading attendance.</p>
                <AttendanceSkeleton />
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
