"use client";

import { useState } from "react";
import Link from "next/link";

import { formatDate } from "~/app/portal/_lib/format";
import { Eyebrow } from "~/components/site";
import { Skeleton } from "~/components/ui/skeleton";
import { cn } from "~/lib/utils";
import { api, type RouterOutputs } from "~/trpc/react";

type Attendance = RouterOutputs["chapter"]["attendance"];
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
              "text-xs min-h-9 rounded-md px-3 py-1.5 font-semibold transition-all",
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

function PeriodFigures({ data }: { data: Attendance }) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="border-hairline bg-paper rounded-lg border p-4 shadow-xs">
        <Eyebrow as="dt" tone="muted" rule={false} className="text-xs uppercase tracking-wider text-ink-muted font-semibold">
          Check-ins
        </Eyebrow>
        <dd className="font-display text-navy text-2xl font-bold mt-2 tabular-nums">
          {data.checkIns}
        </dd>
      </div>
      <div className="border-hairline bg-paper rounded-lg border p-4 shadow-xs">
        <Eyebrow as="dt" tone="muted" rule={false} className="text-xs uppercase tracking-wider text-ink-muted font-semibold">
          Members who came
        </Eyebrow>
        <dd className="font-display text-navy text-2xl font-bold mt-2 tabular-nums">
          {data.uniqueMembers}
        </dd>
      </div>
      <div className="border-hairline bg-paper rounded-lg border p-4 shadow-xs">
        <Eyebrow as="dt" tone="muted" rule={false} className="text-xs uppercase tracking-wider text-ink-muted font-semibold">
          Events
        </Eyebrow>
        <dd className="font-display text-navy text-2xl font-bold mt-2 tabular-nums">
          {data.events}
        </dd>
      </div>
      <div className="border-hairline bg-paper rounded-lg border p-4 shadow-xs">
        <Eyebrow as="dt" tone="muted" rule={false} className="text-xs uppercase tracking-wider text-ink-muted font-semibold">
          Average attendance
        </Eyebrow>
        <dd className="font-display text-navy text-2xl font-bold mt-2 tabular-nums">
          {data.averageAttendance.toFixed(1)}
        </dd>
      </div>
    </dl>
  );
}

function EventBars({ series }: { series: Attendance["series"] }) {
  const peak = Math.max(0, ...series.map((row) => row.checkIns));

  return (
    <ul role="list" className="mt-6 grid gap-3">
      {series.map((row) => {
        const width = peak === 0 ? 0 : (row.checkIns / peak) * 100;
        return (
          <li key={row.id}>
            <Link
              href={`/portal/admin/events/${row.id}`}
              className="border-hairline bg-paper hover:bg-cream/40 focus-visible:ring-gold-bright block rounded-lg border p-4 transition focus-visible:ring-2 focus-visible:outline-none"
            >
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-navy min-w-0 font-semibold">
                  <span className="block truncate">{row.title}</span>
                  <span className="text-ink-muted text-body-sm mt-0.5 block font-normal tabular-nums">
                    {formatDate(row.startsAt)}
                  </span>
                </p>
                <div className="flex items-baseline gap-1.5 shrink-0">
                  <span className="font-display text-navy text-lg font-bold tabular-nums">
                    {row.checkIns}
                  </span>
                  <span className="text-ink-muted text-xs font-normal">
                    attendees
                  </span>
                </div>
              </div>
              <div
                className="bg-sand/60 mt-3 h-2 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <div
                  className="bg-gold-bright h-full rounded-full transition-all duration-500"
                  style={{ width: `${width}%` }}
                />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function AttendanceBody({ data }: { data: Attendance }) {
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
      <PeriodFigures data={data} />
      <EventBars series={data.series} />
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((figure) => (
          <div key={figure} className="border-hairline bg-paper/50 rounded-lg border p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-6 grid gap-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="border-hairline bg-paper/50 rounded-lg border p-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-3 h-2 w-full" />
          </div>
        ))}
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

  return (
    <section
      aria-labelledby="attendance-heading"
      className="border-hairline border-b py-8 sm:py-10"
    >
      <div className="max-w-content mx-auto px-5 sm:px-6">
        <div className="border-hairline bg-paper/50 rounded-xl border p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-hairline border-b pb-6">
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
              <AttendanceBody data={attendance.data} />
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
