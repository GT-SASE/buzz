import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { eventPagePath, eventPath, signInPath } from "~/app/portal/_lib/paths";
import { Eyebrow, PageHeader, Section, TextLink } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Badge } from "~/components/ui/badge";
import {
  getChapterEvent,
  getChapterEvents,
  type PublicEvent,
} from "~/data/chapter-events";
import { site } from "~/data/site";
import { googleCalendarUrl } from "~/lib/calendar";
import {
  formatClockWithZone,
  formatLongDate,
  isSettled,
  localDateKey,
} from "~/lib/event-time";
import { clipText, eventSchema, pageMetadata } from "~/lib/seo";

// Hourly, like /events: an event an officer edits shows up without a deploy.
export const revalidate = 3600;

type Params = { params: Promise<{ id: string }> };

/**
 * Upcoming events are built ahead; the archive renders on its first visit and
 * is cached from then on, so a build does not carry two hundred old pages.
 */
export async function generateStaticParams() {
  const { upcoming } = await getChapterEvents();
  return upcoming.map((event) => ({ id: event.id }));
}

/** Absolute, because link-preview crawlers do not resolve a relative path. */
function cardImage(event: PublicEvent) {
  return {
    url: `${site.url}${eventPagePath(event.id)}/card?v=1`,
    width: 1200,
    height: 630,
    alt: `${event.title}, ${event.displayDate}`,
    type: "image/png",
  };
}

function summary(event: PublicEvent) {
  const lead = `${event.displayDate}${event.location ? `, ${event.location}` : ""}.`;
  return clipText(
    event.description ? `${lead} ${event.description}` : lead,
    200,
  );
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const event = await getChapterEvent(id);
  if (!event) return {};
  return pageMetadata({
    title: `${event.title} | ${site.name}`,
    description: summary(event),
    path: eventPagePath(event.id),
    image: cardImage(event),
  });
}

export default async function EventPage({ params }: Params) {
  const { id } = await params;
  const event = await getChapterEvent(id);
  if (!event) notFound();

  // The same cut /events uses between "on the calendar" and "what we have run".
  const past = isSettled(event);
  const time = event.reminder ? null : formatClockWithZone(event.startsAt);

  return (
    <>
      <JsonLd data={eventSchema({ ...event, image: cardImage(event).url })} />
      <PageHeader title={event.title} />

      <Section size="sm">
        <nav aria-label="Breadcrumb" className="mb-10">
          <Link
            href="/events"
            className="text-navy decoration-gold hover:text-gold-ink text-body-sm inline-flex min-h-11 items-center font-semibold underline decoration-2 underline-offset-4 transition"
          >
            <span aria-hidden="true">&larr;&nbsp;</span>All events
          </Link>
        </nav>

        <div className="max-w-measure">
          {event.reminder && (
            <Badge
              variant="outline"
              className="border-hairline text-ink-muted text-eyebrow tracking-masthead mb-8 w-fit rounded-md px-2.5 py-1 font-semibold uppercase"
            >
              Campus reminder
            </Badge>
          )}

          <dl className="grid gap-x-10 gap-y-6 sm:grid-cols-[6rem_1fr]">
            <Eyebrow as="dt" tone="gold" rule={false} className="sm:pt-1.5">
              When
            </Eyebrow>
            <dd className="text-body text-ink">
              <time
                dateTime={
                  event.reminder
                    ? localDateKey(event.startsAt)
                    : event.startsAt.toISOString()
                }
              >
                {formatLongDate(event.startsAt)}
                {time && (
                  <>
                    <br />
                    {time}
                  </>
                )}
              </time>
            </dd>
            {event.location && (
              <>
                <Eyebrow as="dt" tone="gold" rule={false} className="sm:pt-1.5">
                  Where
                </Eyebrow>
                <dd className="text-body text-ink">{event.location}</dd>
              </>
            )}
          </dl>

          {event.description && (
            <p className="text-body text-ink-muted mt-10 leading-relaxed break-words whitespace-pre-line">
              {event.description}
            </p>
          )}

          <div className="border-hairline mt-12 flex flex-wrap gap-x-8 border-t pt-4">
            {past ? (
              <TextLink href="/events">See what is coming up</TextLink>
            ) : (
              <>
                {!event.reminder && (
                  <TextLink href={signInPath(eventPath(event.id))}>
                    Sign in to RSVP
                  </TextLink>
                )}
                <TextLink href={googleCalendarUrl(event)} external>
                  Add to Google Calendar
                </TextLink>
              </>
            )}
          </div>
          {past && (
            <p className="text-ink-muted text-body-sm mt-2">
              This event has passed.
            </p>
          )}
        </div>
      </Section>
    </>
  );
}
