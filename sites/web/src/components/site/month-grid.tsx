import Link from "next/link";

import { eventMonthPath, eventPagePath } from "~/app/portal/_lib/paths";
import {
  dayLabel,
  eventEnd,
  formatClock,
  monthLabel,
  type GridDay,
  type GridEntry,
  type MonthKey,
  type SpanEvent,
} from "~/lib/event-time";

const weekdays = [
  { short: "Sun", long: "Sunday" },
  { short: "Mon", long: "Monday" },
  { short: "Tue", long: "Tuesday" },
  { short: "Wed", long: "Wednesday" },
  { short: "Thu", long: "Thursday" },
  { short: "Fri", long: "Friday" },
  { short: "Sat", long: "Saturday" },
] as const;

/** What to print beside a title on a given day. */
function when(entry: GridEntry<SpanEvent>) {
  const { event, startsHere, endsHere } = entry;
  if (event.reminder) return "All day";
  if (!startsHere) return `Until ${formatClock(eventEnd(event))}`;
  const start = formatClock(event.startsAt);
  return endsHere ? start : `${start}, runs past midnight`;
}

const entryLink =
  "text-navy decoration-gold hover:text-gold-ink font-semibold underline decoration-1 underline-offset-2 break-words";

function Entries({ entries }: { entries: GridEntry<SpanEvent>[] }) {
  return (
    <ul role="list" className="space-y-2">
      {entries.map((entry) => (
        <li key={entry.event.id} className="leading-snug">
          <Link href={eventPagePath(entry.event.id)} className={entryLink}>
            {entry.event.title}
          </Link>
          <span className="text-ink-muted block">{when(entry)}</span>
        </li>
      ))}
    </ul>
  );
}

function MonthLink({
  month,
  direction,
}: {
  month: MonthKey | null;
  direction: "prev" | "next";
}) {
  // Keep the slot so the title stays centred when a side has nowhere to go.
  if (!month) return <span aria-hidden="true" className="sm:min-w-32" />;
  const label = monthLabel(month);
  return (
    <Link
      href={eventMonthPath(month)}
      rel={direction}
      className="text-navy decoration-gold hover:text-gold-ink text-body-sm inline-flex min-h-11 items-center gap-2 font-semibold underline decoration-2 underline-offset-4 transition data-[direction=next]:justify-end sm:min-w-32"
      data-direction={direction}
    >
      {direction === "prev" && <span aria-hidden="true">&larr;</span>}
      <span>
        <span className="sr-only">
          {direction === "prev" ? "Previous month, " : "Next month, "}
        </span>
        {label}
      </span>
      {direction === "next" && <span aria-hidden="true">&rarr;</span>}
    </Link>
  );
}

/**
 * One month of the calendar. From `md` up it is a real table, so a screen
 * reader gets row and column headers; below that the seven columns would be
 * unreadably narrow, so it is a plain agenda of the days that have events. Both
 * are in the HTML and CSS picks one, which keeps the page free of client code.
 */
export function MonthGrid({
  month,
  weeks,
  previous,
  next,
}: {
  month: MonthKey;
  weeks: GridDay<SpanEvent>[][];
  previous: MonthKey | null;
  next: MonthKey | null;
}) {
  const label = monthLabel(month);
  const busyDays = weeks.flat().filter((day) => day.entries.length > 0);

  return (
    <div>
      <nav
        aria-label="Month"
        className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 sm:flex-nowrap"
      >
        <MonthLink month={previous} direction="prev" />
        {/* On a phone the title takes its own row above the two links. */}
        <h2 className="font-display text-navy text-h3 order-first w-full text-center font-bold sm:order-none sm:w-auto">
          {label}
        </h2>
        <MonthLink month={next} direction="next" />
      </nav>

      {busyDays.length === 0 && (
        <p className="text-ink-muted text-body mb-6">
          Nothing is scheduled in {label}.
        </p>
      )}

      <table className="border-hairline text-body-sm hidden w-full table-fixed border-collapse border md:table">
        <caption className="sr-only">Events in {label}</caption>
        <thead>
          <tr>
            {weekdays.map((weekday) => (
              <th
                key={weekday.short}
                scope="col"
                className="border-hairline bg-cream text-ink-muted text-eyebrow tracking-masthead border px-2 py-2 text-left font-semibold uppercase"
              >
                <span aria-hidden="true">{weekday.short}</span>
                <span className="sr-only">{weekday.long}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week[0]!.key}>
              {week.map((day) =>
                day.inMonth ? (
                  <td
                    key={day.key}
                    className="border-hairline h-32 min-w-0 border p-2 align-top"
                  >
                    <p className="text-ink-muted mb-1 font-semibold">
                      <span aria-hidden="true">{day.day}</span>
                      <span className="sr-only">{dayLabel(day.key)}</span>
                    </p>
                    {day.entries.length > 0 && (
                      <Entries entries={day.entries} />
                    )}
                  </td>
                ) : (
                  <td
                    key={day.key}
                    className="border-hairline bg-cream/60 border"
                  />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {busyDays.length > 0 && (
        <ol
          role="list"
          className="border-hairline divide-hairline divide-y border-y md:hidden"
        >
          {busyDays.map((day) => (
            <li key={day.key} className="py-5">
              <h3 className="font-display text-navy text-h3 mb-3 font-bold">
                <time dateTime={day.key}>{dayLabel(day.key)}</time>
              </h3>
              <div className="text-body-sm">
                <Entries entries={day.entries} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
