"use client";

import { Eyebrow } from "~/components/site";
import { Skeleton } from "~/components/ui/skeleton";
import { tiers } from "~/data/portal";
import { api, type RouterOutputs } from "~/trpc/react";

type Metrics = RouterOutputs["member"]["metrics"];

/** The floors the tier table is built from. Sent so the server bands on the
    same thresholds the cards render. */
export const tierFloors = tiers.map((tier) => tier.min);

const figureGrid = "grid gap-4 sm:grid-cols-2 lg:grid-cols-4";

function share(part: number, whole: number) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

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

function TierBars({ data }: { data: Metrics }) {
  // Matched on the floor rather than on position: the server sorts what it was
  // sent, and a name against the wrong band is worse than no band at all.
  const bands = tiers.map((tier) => ({
    name: tier.name,
    min: tier.min,
    members: data.tiers.find((row) => row.min === tier.min)?.members ?? 0,
  }));

  return (
    <div className="border-hairline bg-paper/60 shadow-xs mt-8 rounded-xl border p-6">
      <div className="border-hairline border-b pb-4">
        <h3 className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase">
          Where the roster sits
        </h3>
        <p className="text-ink-muted text-body-sm mt-0.5">
          Member progression across chapter point tiers.
        </p>
      </div>
      <ul role="list" className="mt-6 grid gap-4">
        {bands.map((band) => {
          const percent = share(band.members, data.total);
          return (
            <li key={band.name}>
              <div className="flex items-baseline justify-between gap-4">
                <p className="text-navy font-semibold">
                  {band.name}
                  <span className="text-ink-muted text-body-sm ml-2 font-normal tabular-nums">
                    {band.min}+ pts
                  </span>
                </p>
                <p className="text-navy shrink-0 font-semibold tabular-nums">
                  {band.members}
                  <span className="text-ink-muted ml-2 font-normal">
                    {percent}%
                  </span>
                </p>
              </div>
              <div
                className="bg-sand/60 mt-2 h-2.5 overflow-hidden rounded-full"
                aria-hidden="true"
              >
                <div
                  className="bg-gold-bright h-full rounded-full transition-all duration-500"
                  style={{ width: `${percent}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Figures({ data }: { data: Metrics }) {
  if (data.total === 0) {
    return (
      <div className="border-hairline bg-paper rounded-xl border p-6">
        <p className="font-display text-navy text-h3 font-bold">
          Nobody has signed in yet.
        </p>
        <p className="text-ink-muted text-body max-w-measure mt-3">
          Members appear here the first time they sign in to the portal, whether
          or not they have been to an event.
        </p>
      </div>
    );
  }

  return (
    <>
      <dl className={figureGrid}>
        <Figure
          label="Members"
          value={String(data.total)}
          note={`${data.officers} ${data.officers === 1 ? "officer" : "officers"}`}
        />
        <Figure
          label="Active this year"
          value={String(data.activeThisYear)}
          note={`${share(data.activeThisYear, data.total)}% of the roster · ${data.activeLast30} in the last 30 days`}
        />
        <Figure
          label="New this month"
          value={String(data.newLast30)}
          note="first check-in in the last 30 days"
        />
        <Figure
          label="Average points"
          value={data.averagePoints.toFixed(1)}
          note={`${data.neverCheckedIn} never checked in`}
        />
      </dl>

      <TierBars data={data} />
    </>
  );
}

function MetricsSkeleton() {
  return (
    <>
      <p className="sr-only">Loading roster figures.</p>
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
        <div className="border-hairline bg-paper/50 mt-8 rounded-xl border p-6">
          <Skeleton className="h-4 w-40" />
          <div className="mt-6 grid gap-4">
            {[0, 1, 2, 3].map((band) => (
              <div key={band}>
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-2 h-2.5 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/** The roster, in figures. Sits above the table and never blocks it. */
export function RosterMetrics() {
  const metrics = api.member.metrics.useQuery({ tiers: tierFloors });

  return (
    <section
      aria-labelledby="roster-metrics-heading"
      className="border-hairline border-b bg-cream/30"
    >
      <div className="max-w-content mx-auto px-5 py-8 sm:px-6 sm:py-10">
        <div className="mb-6 flex items-center justify-between">
          <h2
            id="roster-metrics-heading"
            className="text-eyebrow tracking-caps text-ink-muted font-semibold uppercase"
          >
            Roster at a glance
          </h2>
        </div>

        <div aria-live="polite" aria-busy={metrics.isPending}>
          {/* Cached figures outrank a failed background refetch. */}
          {metrics.data ? (
            <Figures data={metrics.data} />
          ) : metrics.error ? (
            <p className="text-ink-muted text-body-sm">
              Roster figures are unavailable right now. The table below is
              unaffected.
            </p>
          ) : (
            <MetricsSkeleton />
          )}
        </div>
      </div>
    </section>
  );
}
