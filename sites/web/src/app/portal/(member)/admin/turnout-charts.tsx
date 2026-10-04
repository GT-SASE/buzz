"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { formatDate } from "~/app/portal/_lib/format";
import { type RouterOutputs } from "~/trpc/react";

type Turnout = RouterOutputs["chapter"]["turnout"];
type TurnoutEvent = Turnout["events"][number];

/**
 * Checked with the dataviz palette validator against the paper surface:
 * CVD and normal-vision separation pass; gold is under 3:1 contrast, so both
 * charts keep a legend and a table view.
 */
const series = {
  returning: { label: "Returning", color: "#2a6db0" },
  firstTimers: { label: "First-timers", color: "#c48a00" },
} as const;
const GRID = "rgb(36 31 26 / 0.12)";

const CHART_HEIGHT = 220;
const AXIS_WIDTH = 32;
const AXIS_HEIGHT = 24;
/** Room above the top tick so its label is not clipped. */
const TOP_PAD = 10;
const MAX_COLUMN = 24;
const GAP = 2;

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/New_York",
});

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 0 plus up to four clean steps that cover `max`. */
function ticksFor(max: number) {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ??
    10 * magnitude;
  const ticks = [];
  for (let value = 0; value < max + step; value += step) ticks.push(value);
  return ticks;
}

/** A column segment with its top corners rounded (the data end). */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + w - radius} Q${x + w},${y} ${x + w},${y + radius} V${y + h} Z`;
}

export function Legend() {
  return (
    <ul className="text-ink-muted text-body-sm flex flex-wrap gap-x-5 gap-y-1">
      {Object.values(series).map((item) => (
        <li key={item.label} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 rounded-sm"
            style={{ backgroundColor: item.color }}
          />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Stacked columns, one per past event, oldest on the left. */
export function TurnoutChart({ events }: { events: TurnoutEvent[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number | null>(null);

  const plotWidth = Math.max(0, width - AXIS_WIDTH);
  const band = events.length > 0 ? plotWidth / events.length : 0;
  const column = Math.min(MAX_COLUMN, band * 0.6);
  const ticks = ticksFor(Math.max(0, ...events.map((row) => row.checkIns)));
  const top = ticks[ticks.length - 1] ?? 1;
  const y = (value: number) =>
    TOP_PAD + (CHART_HEIGHT - TOP_PAD) * (1 - value / top);
  // Enough room for "Oct 12" under each labelled column.
  const labelEvery = Math.max(1, Math.ceil(48 / Math.max(band, 1)));
  const active = hovered === null ? null : events[hovered];

  return (
    <div ref={ref} className="relative">
      {width > 0 && (
        <svg
          width={width}
          height={CHART_HEIGHT + AXIS_HEIGHT}
          role="img"
          aria-label={`Check-ins per event, split into returning members and first-timers, for ${events.length} events. The table below has every value.`}
          onMouseLeave={() => setHovered(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={AXIS_WIDTH}
                x2={width}
                y1={y(tick)}
                y2={y(tick)}
                stroke={GRID}
              />
              <text
                x={AXIS_WIDTH - 8}
                y={y(tick)}
                dy="0.32em"
                textAnchor="end"
                className="fill-ink-muted text-[11px] tabular-nums"
              >
                {tick}
              </text>
            </g>
          ))}

          {events.map((row, index) => {
            const x = AXIS_WIDTH + index * band + (band - column) / 2;
            const returningTop = y(row.returning);
            const totalTop = y(row.checkIns);
            const hasFirst = row.firstTimers > 0;
            const dim = hovered !== null && hovered !== index;
            return (
              <g key={row.id} opacity={dim ? 0.45 : 1}>
                {row.returning > 0 && (
                  <path
                    d={
                      hasFirst
                        ? `M${x},${CHART_HEIGHT} V${returningTop} H${x + column} V${CHART_HEIGHT} Z`
                        : topRounded(
                            x,
                            returningTop,
                            column,
                            CHART_HEIGHT - returningTop,
                            4,
                          )
                    }
                    fill={series.returning.color}
                  />
                )}
                {hasFirst && (
                  <path
                    d={topRounded(
                      x,
                      totalTop,
                      column,
                      Math.max(
                        0,
                        returningTop - totalTop - (row.returning > 0 ? GAP : 0),
                      ),
                      4,
                    )}
                    fill={series.firstTimers.color}
                  />
                )}
                {index % labelEvery === 0 && (
                  <text
                    x={x + column / 2}
                    y={CHART_HEIGHT + 16}
                    textAnchor="middle"
                    className="fill-ink-muted text-[11px]"
                  >
                    {shortDate.format(row.startsAt)}
                  </text>
                )}
                {/* Hit target: the whole band, not just the mark. */}
                <rect
                  x={AXIS_WIDTH + index * band}
                  y={0}
                  width={band}
                  height={CHART_HEIGHT}
                  fill="transparent"
                  onMouseEnter={() => setHovered(index)}
                />
              </g>
            );
          })}
        </svg>
      )}

      {active && hovered !== null && (
        <div
          role="status"
          className="border-hairline bg-paper pointer-events-none absolute top-0 z-10 w-56 rounded-lg border p-3 shadow-md"
          style={{
            left: Math.min(
              Math.max(0, AXIS_WIDTH + hovered * band + band / 2 - 112),
              Math.max(0, width - 224),
            ),
          }}
        >
          <p className="text-navy text-body-sm font-semibold">{active.title}</p>
          <p className="text-ink-muted text-xs">
            {formatDate(active.startsAt)}
          </p>
          <dl className="text-body-sm mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5 tabular-nums">
            {(["returning", "firstTimers"] as const).map((key) => (
              <div key={key} className="contents">
                <dt className="text-ink-muted flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-2.5 rounded-sm"
                    style={{ backgroundColor: series[key].color }}
                  />
                  {series[key].label}
                </dt>
                <dd className="text-ink text-right">{active[key]}</dd>
              </div>
            ))}
            <dt className="text-ink font-semibold">Total</dt>
            <dd className="text-ink text-right font-semibold">
              {active.checkIns}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}

/** The same numbers as the chart, for screen readers and exact values. */
export function TurnoutTable({ events }: { events: TurnoutEvent[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-body-sm w-full min-w-[32rem] tabular-nums">
        <thead className="text-ink-muted text-left text-xs uppercase">
          <tr className="border-hairline border-b">
            <th className="py-2 font-semibold">Event</th>
            <th className="py-2 font-semibold">Date</th>
            <th className="py-2 text-right font-semibold">Returning</th>
            <th className="py-2 text-right font-semibold">First-timers</th>
            <th className="py-2 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {[...events].reverse().map((row) => (
            <tr key={row.id} className="border-hairline border-b">
              <td className="py-2 pr-4">
                <Link
                  href={`/portal/admin/events/${row.id}`}
                  className="text-navy font-semibold hover:underline"
                >
                  {row.title}
                </Link>
              </td>
              <td className="text-ink-muted py-2 pr-4">
                {formatDate(row.startsAt)}
              </td>
              <td className="py-2 text-right">{row.returning}</td>
              <td className="py-2 text-right">{row.firstTimers}</td>
              <td className="py-2 text-right font-semibold">{row.checkIns}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** RSVPs for what is coming up, one bar each. */
export function RsvpBars({ upcoming }: { upcoming: Turnout["upcoming"] }) {
  const peak = Math.max(1, ...upcoming.map((row) => row.rsvps));
  return (
    <ul role="list" className="grid gap-3">
      {upcoming.map((row) => (
        <li key={row.id}>
          <Link
            href={`/portal/admin/events/${row.id}`}
            className="hover:bg-cream/40 focus-visible:ring-gold-bright grid gap-1.5 rounded-md p-1 transition focus-visible:ring-2 focus-visible:outline-none sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-center sm:gap-4"
          >
            <span className="min-w-0">
              <span className="text-navy text-body-sm block truncate font-semibold">
                {row.title}
              </span>
              <span className="text-ink-muted block text-xs">
                {formatDate(row.startsAt)}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-4 rounded-r"
                style={{
                  width: `${(row.rsvps / peak) * 85}%`,
                  minWidth: row.rsvps > 0 ? 4 : 0,
                  backgroundColor: series.returning.color,
                }}
              />
              <span className="text-ink text-body-sm font-semibold tabular-nums">
                {row.rsvps}
                <span className="sr-only"> RSVPs</span>
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
