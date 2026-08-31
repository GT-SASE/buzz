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
      className="flex flex-wrap gap-1"
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
              "text-body-sm min-h-11 rounded-md px-3 py-2 font-medium",
              selected
                ? "bg-navy text-paper"
                : "text-ink-muted hover:bg-cream hover:text-navy",
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
    <dl className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
      <div>
        <Eyebrow as="dt" tone="muted" rule={false}>
          Check-ins
        </Eyebrow>
        <dd className="font-display text-navy text-h3 mt-3 font-bold tabular-nums">
          {data.checkIns}
        </dd>
      </div>
      <div>
        <Eyebrow as="dt" tone="muted" rule={false}>
          Members who came
        </Eyebrow>
        <dd className="font-display text-navy text-h3 mt-3 font-bold tabular-nums">
          {data.uniqueMembers}
        </dd>
      </div>
      <div>
        <Eyebrow as="dt" tone="muted" rule={false}>
          Events
        </Eyebrow>
        <dd className="font-display text-navy text-h3 mt-3 font-bold tabular-nums">
          {data.events}
        </dd>
      </div>
      <div>
        <Eyebrow as="dt" tone="muted" rule={false}>
          Average attendance
        </Eyebrow>
        <dd className="font-display text-navy text-h3 mt-3 font-bold tabular-nums">
          {data.averageAttendance.toFixed(1)}
        </dd>
      </div>
    </dl>
  );
}

function EventBars({ series }: { series: Attendance["series"] }) {
  const peak = Math.max(0, ...series.map((row) => row.checkIns));

  return (
    <ul role="list" className="mt-8 grid gap-4">
      {series.map((row) => {
        const width = peak === 0 ? 0 : (row.checkIns / peak) * 100;
        return (
          <li key={row.id}>
            <Link
              href={`/portal/admin/events/${row.id}`}
              className="hover:bg-cream focus-visible:ring-gold-bright -mx-2 block rounded-md px-2 py-2 focus-visible:ring-2 focus-visible:outline-none"
            >
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-navy min-w-0 font-semibold">
                  <span className="block truncate">{row.title}</span>
                  <span className="text-ink-muted text-body-sm mt-1 block font-normal tabular-nums">
                    {formatDate(row.startsAt)}
                  </span>
                </p>
                <p className="text-navy shrink-0 font-semibold tabular-nums">
                  {row.checkIns}
                </p>
              </div>
              <div
                className="bg-sand mt-3 h-2 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <div
                  className="bg-gold-bright h-full rounded-full"
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
      <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((figure) => (
          <div key={figure}>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-8 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-8 grid gap-6">
        {[0, 1, 2].map((row) => (
          <div key={row}>
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
      className="border-hairline border-b"
    >
      <div className="max-w-content mx-auto px-5 py-10 sm:px-6 sm:py-12">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2
            id="attendance-heading"
            className="text-eyebrow tracking-caps text-ink-muted border-hairline border-b pb-3 font-semibold uppercase sm:border-0 sm:pb-0"
          >
            Attendance over time
          </h2>
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
    </section>
  );
}
