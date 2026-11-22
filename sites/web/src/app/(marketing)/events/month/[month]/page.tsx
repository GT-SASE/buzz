import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { eventMonthPath } from "~/app/portal/_lib/paths";
import { EventsToolbar } from "~/components/site/events-toolbar";
import { MonthGrid } from "~/components/site/month-grid";
import { PageHeader, Section } from "~/components/site";
import { getChapterCalendar, getChapterEvents } from "~/data/chapter-events";
import { site } from "~/data/site";
import {
  isMonthKey,
  monthBounds,
  monthGrid,
  monthKeyOf,
  monthLabel,
  shiftMonth,
} from "~/lib/event-time";
import { pageMetadata } from "~/lib/seo";

// Hourly, like /events: an event an officer edits shows up without a deploy.
export const revalidate = 3600;

type Params = { params: Promise<{ month: string }> };

/**
 * The months a visitor is likely to open: half a year back, a year ahead,
 * and only where events exist. Any other month in range renders on its first
 * visit and is cached from then on.
 */
export async function generateStaticParams() {
  const { upcoming, past } = await getChapterEvents();
  const current = monthKeyOf(new Date());
  const bounds = monthBounds([...upcoming, ...past], new Date());
  const months: string[] = [];
  for (let month = shiftMonth(current, -6); month <= shiftMonth(current, 12);) {
    if (month >= bounds.first && month <= bounds.last) months.push(month);
    month = shiftMonth(month, 1);
  }
  return months.map((month) => ({ month }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { month } = await params;
  if (!isMonthKey(month)) return {};
  const label = monthLabel(month);
  return {
    ...pageMetadata({
      title: `${label} events | ${site.name}`,
      description: `Every SASE at Georgia Tech event in ${label}, on a calendar.`,
      path: eventMonthPath(month),
    }),
    // A grid of the same events /events lists, one page per month with no
    // end: worth a visit, not worth a search result.
    robots: { index: false, follow: true },
  };
}

export default async function EventsMonthPage({ params }: Params) {
  const { month } = await params;
  if (!isMonthKey(month)) notFound();

  const { upcoming, past } = await getChapterCalendar();
  const events = [...past, ...upcoming];
  const now = new Date();
  const { first, last } = monthBounds(events, now);
  if (month < first || month > last) notFound();

  return (
    <>
      <PageHeader
        title="Events."
        body="General body meetings, workshops, socials, and conferences. Open to all Georgia Tech students unless noted."
      />
      <Section size="sm">
        <EventsToolbar
          view="month"
          monthHref={eventMonthPath(monthKeyOf(now))}
        />
        <MonthGrid
          month={month}
          weeks={monthGrid(month, events)}
          previous={month > first ? shiftMonth(month, -1) : null}
          next={month < last ? shiftMonth(month, 1) : null}
        />
      </Section>
    </>
  );
}
