import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { eventPagePath, rsvpSignInPath } from "~/app/portal/_lib/paths";
import { Button, Card, Eyebrow, TextLink } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { RsvpControl, RsvpProvider } from "~/components/site/rsvp";
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

      {/* The header's own geometry (PageHeader's rule, padding and two columns),
          with the back link above it and the facts and actions beside the title.
          On a phone the order is title, facts and actions, then the description,
          so the RSVP is never below a long description. */}
      <div className="relative overflow-hidden px-5 pt-6 pb-12 sm:px-6 sm:pt-10 sm:pb-20">
        <div className="max-w-content relative mx-auto">
          <nav aria-label="Breadcrumb" className="mb-4">
            <Link
              href="/events"
              className="text-navy decoration-gold hover:text-gold-ink text-body-sm inline-flex min-h-11 items-center font-semibold underline decoration-2 underline-offset-4 transition"
            >
              <span aria-hidden="true">&larr;&nbsp;</span>All events
            </Link>
          </nav>

          <div className="rule-heavy grid gap-x-16 gap-y-8 pt-8 lg:grid-cols-[1.35fr_1fr] lg:grid-rows-[auto_1fr] lg:items-start">
            <div className="lg:col-start-1 lg:row-start-1">
              {event.reminder && (
                <Badge
                  variant="outline"
                  className="border-hairline text-ink-muted text-eyebrow tracking-masthead mb-6 w-fit rounded-md px-2.5 py-1 font-semibold uppercase"
                >
                  Campus reminder
                </Badge>
              )}
              <h1 className="font-display text-navy text-h1 font-bold tracking-tight text-balance">
                {event.title}
              </h1>
            </div>

            <Card
              tone="cream"
              className="lg:col-start-2 lg:row-span-2 lg:row-start-1"
            >
              <dl className="grid gap-x-6 gap-y-5 sm:grid-cols-[5rem_1fr]">
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
                    <Eyebrow
                      as="dt"
                      tone="gold"
                      rule={false}
                      className="sm:pt-1.5"
                    >
                      Where
                    </Eyebrow>
                    <dd className="text-body text-ink">{event.location}</dd>
                  </>
                )}
              </dl>

              <div className="border-hairline mt-6 flex flex-col items-start gap-1 border-t pt-5">
                {past ? (
                  <>
                    <p className="text-ink-muted text-body-sm">
                      This event has passed.
                    </p>
                    <TextLink href="/events">See what is coming up</TextLink>
                  </>
                ) : (
                  <RsvpProvider
                    eventIds={event.reminder ? [] : [event.id]}
                    returnTo={event.id}
                  >
                    {!event.reminder && (
                      <RsvpControl
                        eventId={event.id}
                        title={event.title}
                        startsAt={event.startsAt.toISOString()}
                        prominent
                      >
                        <Button
                          href={rsvpSignInPath(event.id)}
                          variant="primary"
                        >
                          Sign in to RSVP
                        </Button>
                      </RsvpControl>
                    )}
                    <TextLink href={googleCalendarUrl(event)} external>
                      Add to Google Calendar
                    </TextLink>
                  </RsvpProvider>
                )}
              </div>
            </Card>

            {event.description && (
              <p className="text-body text-ink-muted max-w-measure leading-relaxed break-words whitespace-pre-line lg:col-start-1 lg:row-start-2">
                {event.description}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
