"use client";

import { useEffect, useState } from "react";

import { Eyebrow } from "~/components/site/layout";
import { cn } from "~/lib/utils";
import {
  barDays,
  summarize,
  uptimeDataUrl,
  type DaySummary,
  type FeatureSummary,
  type UptimeHistory,
  type UptimeSummary,
} from "~/lib/uptime";

const headline = {
  up: { label: "Everything is up.", pip: "bg-emerald-600" },
  down: { label: "Something is down.", pip: "bg-destructive" },
  stale: { label: "No recent check.", pip: "bg-ink-muted" },
} as const;

const statLabel =
  "text-eyebrow tracking-masthead text-ink-muted font-semibold uppercase";

function formatPercent(value: number | null) {
  if (value === null) return "—";
  // 99.95 must not round up to a perfect 100.
  return `${(Math.floor(value * 100) / 100).toFixed(2)}%`;
}

function formatMs(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function barColor(value: number | null) {
  if (value === null) return "bg-hairline";
  if (value >= 99.5) return "bg-emerald-600";
  if (value >= 95) return "bg-gold";
  return "bg-destructive";
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function ago(date: Date, now: Date) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  return relative.format(Math.round(minutes / 60), "hour");
}

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "America/New_York",
  timeZoneName: "short",
});

const dayName = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function formatDay(date: string) {
  return dayName.format(new Date(`${date}T12:00:00Z`));
}

export function UptimeBoard() {
  const [summary, setSummary] = useState<UptimeSummary | "error" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch(uptimeDataUrl, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<UptimeHistory>;
      })
      .then((history) => {
        if (history.version !== 2) throw new Error("Unknown uptime format");
        setSummary(summarize(history, new Date()));
      })
      .catch(() => setSummary("error"));
  }, []);

  if (summary === null) {
    return (
      <p className="text-ink-muted text-body">Loading the latest check…</p>
    );
  }
  if (summary === "error") {
    return (
      <p className="text-ink-muted text-body">
        Uptime history is not available right now.
      </p>
    );
  }

  const now = new Date();
  const { label, pip } = headline[summary.state];
  const day =
    summary.days.find((entry) => entry.date === selected) ??
    summary.days.at(-1);
  // One scale for every feature, so a slower line looks slower.
  const maxMs = Math.max(
    100,
    ...summary.features.flatMap((feature) =>
      feature.recent.map((sample) => sample.ms ?? 0),
    ),
  );

  return (
    <div>
      <div className="flex items-center gap-4">
        <span className={cn("size-3 shrink-0 rounded-full", pip)} />
        <h2 className="font-display text-navy text-h3 font-bold">{label}</h2>
      </div>
      <p className="text-ink-muted text-body-sm mt-2">
        Last checked {ago(summary.checkedAt, now)}.
      </p>

      <dl className="border-hairline mt-10 grid grid-cols-3 border-t">
        {summary.windows.map((window) => (
          <div key={window.days} className="border-hairline border-b py-5">
            <dt className={statLabel}>{window.days} days</dt>
            <dd className="text-navy text-h3 mt-2 font-bold tabular-nums">
              {formatPercent(window.percent)}
            </dd>
          </div>
        ))}
      </dl>

      <Eyebrow as="h3" className="mt-16">
        Response time, last 24 hours
      </Eyebrow>
      <ul className="mt-6 grid gap-10 md:grid-cols-3 md:gap-8">
        {summary.features.map((feature) => (
          <FeatureCard key={feature.id} feature={feature} maxMs={maxMs} />
        ))}
      </ul>

      <Eyebrow as="h3" className="mt-16">
        Daily uptime, last {barDays} days
      </Eyebrow>
      <div className="mt-6 flex h-10 gap-px">
        {summary.days.map((entry) => (
          <button
            key={entry.date}
            type="button"
            aria-pressed={entry.date === day?.date}
            aria-label={`${formatDay(entry.date)}: ${entry.percent === null ? "no data" : formatPercent(entry.percent)}`}
            title={`${formatDay(entry.date)}: ${entry.percent === null ? "no data" : formatPercent(entry.percent)}`}
            onClick={() => setSelected(entry.date)}
            className={cn(
              "focus-visible:outline-navy min-w-0 flex-1 rounded-[1px] transition-opacity hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2",
              barColor(entry.percent),
              entry.date === day?.date &&
                "outline-navy outline-2 outline-offset-2",
            )}
          />
        ))}
      </div>
      <p className="text-ink-muted text-eyebrow tracking-caps mt-3 flex justify-between uppercase">
        <span>{barDays} days ago</span>
        <span>Today</span>
      </p>

      {day && <DayDetail day={day} />}
    </div>
  );
}

function FeatureCard({
  feature,
  maxMs,
}: {
  feature: FeatureSummary;
  maxMs: number;
}) {
  return (
    <li className="border-hairline border-t pt-5">
      <div className="flex items-baseline justify-between gap-4">
        <h4 className="text-navy text-body font-semibold">{feature.name}</h4>
        <span className="text-ink-muted text-body-sm flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              feature.up ? "bg-emerald-600" : "bg-destructive",
            )}
          />
          {feature.up ? "Up" : "Down"}
        </span>
      </div>
      <dl className="mt-3 flex gap-8">
        <div>
          <dt className={statLabel}>90-day uptime</dt>
          <dd className="text-ink text-body mt-1 font-semibold tabular-nums">
            {formatPercent(feature.uptime)}
          </dd>
        </div>
        <div>
          <dt className={statLabel}>30-day average</dt>
          <dd className="text-ink text-body mt-1 font-semibold tabular-nums">
            {formatMs(feature.averageMs)}
          </dd>
        </div>
      </dl>
      <ResponseChart feature={feature} maxMs={maxMs} />
    </li>
  );
}

const chartWidth = 300;
const chartHeight = 72;

function ResponseChart({
  feature,
  maxMs,
}: {
  feature: FeatureSummary;
  maxMs: number;
}) {
  const samples = feature.recent;
  const [active, setActive] = useState<number | null>(null);

  if (samples.length === 0) {
    return <p className="text-ink-muted text-body-sm mt-4">No samples yet.</p>;
  }

  const x = (index: number) =>
    samples.length < 2
      ? chartWidth
      : (index / (samples.length - 1)) * chartWidth;
  const y = (ms: number) => chartHeight - (ms / maxMs) * chartHeight;

  // A failed check breaks the line instead of dropping it to zero.
  const segments: { index: number; ms: number }[][] = [];
  let run: { index: number; ms: number }[] = [];
  samples.forEach((sample, index) => {
    if (sample.ms === null) {
      if (run.length) segments.push(run);
      run = [];
    } else {
      run.push({ index, ms: sample.ms });
    }
  });
  if (run.length) segments.push(run);

  const line = (points: { index: number; ms: number }[]) =>
    points
      .map((point, i) => `${i ? "L" : "M"}${x(point.index)} ${y(point.ms)}`)
      .join(" ");

  const last = samples.at(-1);
  const shown = active === null ? null : samples[active];
  const left = (index: number) => `${(x(index) / chartWidth) * 100}%`;

  function pick(clientX: number, box: DOMRect) {
    const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    setActive(Math.round(ratio * (samples.length - 1)));
  }

  return (
    <figure className="mt-5">
      <div className="text-ink-muted text-eyebrow flex justify-between tabular-nums">
        <span>{maxMs} ms</span>
        {last && (
          <span className="text-ink font-semibold">
            {last.ms === null ? "Down" : `${last.ms} ms`}
          </span>
        )}
      </div>
      <div
        role="img"
        tabIndex={0}
        aria-label={`${feature.name} response time over the last 24 hours. Use the arrow keys to read each check.`}
        className="focus-visible:outline-navy relative mt-1 h-18 touch-none focus-visible:outline-2 focus-visible:outline-offset-4"
        onPointerMove={(event) =>
          pick(event.clientX, event.currentTarget.getBoundingClientRect())
        }
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -1 : 1;
          setActive((current) =>
            Math.min(
              samples.length - 1,
              Math.max(0, (current ?? samples.length - 1) + step),
            ),
          );
        }}
      >
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          preserveAspectRatio="none"
          className="absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          <line
            x1={0}
            x2={chartWidth}
            y1={chartHeight}
            y2={chartHeight}
            className="stroke-hairline"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          {segments.map((points) => (
            <g key={points[0]?.index}>
              <path
                d={`${line(points)} L${x(points.at(-1)?.index ?? 0)} ${chartHeight} L${x(points[0]?.index ?? 0)} ${chartHeight} Z`}
                className="fill-navy/10"
              />
              <path
                d={line(points)}
                fill="none"
                className="stroke-navy"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        {samples.map((sample, index) =>
          sample.ms === null ? (
            <span
              key={sample.at.toISOString()}
              className="bg-destructive absolute bottom-0 h-2 w-0.5 -translate-x-1/2"
              style={{ left: left(index) }}
            />
          ) : null,
        )}

        {active === null && last?.ms != null && (
          <span
            className="bg-navy ring-paper absolute size-2 -translate-1/2 rounded-full ring-2"
            style={{
              left: "100%",
              top: `${(y(last.ms) / chartHeight) * 100}%`,
            }}
          />
        )}

        {shown && active !== null && (
          <>
            <span
              className="bg-ink-muted/40 pointer-events-none absolute inset-y-0 w-px"
              style={{ left: left(active) }}
            />
            {shown.ms !== null && (
              <span
                className="bg-navy ring-paper pointer-events-none absolute size-2 -translate-1/2 rounded-full ring-2"
                style={{
                  left: left(active),
                  top: `${(y(shown.ms) / chartHeight) * 100}%`,
                }}
              />
            )}
            <span
              className="bg-paper border-hairline text-body-sm pointer-events-none absolute bottom-full mb-2 rounded-md border px-3 py-2 whitespace-nowrap shadow-sm"
              style={{
                left: left(active),
                transform: `translateX(-${(active / Math.max(1, samples.length - 1)) * 100}%)`,
              }}
            >
              <span className="text-ink block font-semibold tabular-nums">
                {shown.ms === null ? "Down" : `${shown.ms} ms`}
              </span>
              <span className="text-ink-muted block">
                {clock.format(shown.at)}
              </span>
            </span>
          </>
        )}
      </div>
      <figcaption className="text-ink-muted text-eyebrow tracking-caps mt-2 flex justify-between uppercase">
        <span>24 hours ago</span>
        <span>Now</span>
      </figcaption>
    </figure>
  );
}

function DayDetail({ day }: { day: DaySummary }) {
  return (
    <section
      aria-live="polite"
      className="bg-cream mt-8 grid gap-8 p-6 sm:p-8 md:grid-cols-[1fr_1.4fr]"
    >
      <div>
        <h4 className="font-display text-navy text-h3 font-bold">
          {formatDay(day.date)}
        </h4>
        <p className="text-ink-muted text-body-sm mt-1">
          {day.percent === null
            ? "No checks ran this day."
            : `${formatPercent(day.percent)} of checks passed.`}
        </p>
        {day.percent !== null && (
          <table className="text-body-sm mt-6 w-full">
            <thead>
              <tr className={cn(statLabel, "text-left")}>
                <th className="pb-2 font-semibold">Feature</th>
                <th className="pb-2 text-right font-semibold">Uptime</th>
                <th className="pb-2 text-right font-semibold">Average</th>
              </tr>
            </thead>
            <tbody>
              {day.features.map((feature) => (
                <tr key={feature.id} className="border-hairline border-t">
                  <td className="text-ink py-2">{feature.name}</td>
                  <td className="text-ink py-2 text-right tabular-nums">
                    {formatPercent(feature.percent)}
                  </td>
                  <td className="text-ink py-2 text-right tabular-nums">
                    {formatMs(feature.averageMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <p className={statLabel}>Failed checks</p>
        {day.incidents.length === 0 ? (
          <p className="text-ink text-body-sm mt-3">None.</p>
        ) : (
          <ol className="mt-3">
            {day.incidents.map((incident) => (
              <li
                key={`${incident.at.toISOString()}-${incident.name}`}
                className="border-hairline text-body-sm flex flex-wrap gap-x-4 border-t py-2"
              >
                <span className="text-ink-muted w-24 shrink-0 tabular-nums">
                  {clock.format(incident.at)}
                </span>
                <span className="text-ink font-semibold">{incident.name}</span>
                <span className="text-ink-muted">{incident.detail}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
