import {
  Button,
  Card,
  CtaPanel,
  EventCard,
  PageHeader,
  Section,
} from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
import { pastEvents, upcomingEvents } from "~/data/content";
import { instagram } from "~/data/site";
import { breadcrumbSchema, eventSchema, pageMetadata } from "~/lib/seo";

// `~/data/content` splits upcoming from past against `Date.now()` at module
// scope, so a prerendered build freezes that split at build time and an event
// that has already finished keeps rendering under the upcoming heading until
// someone redeploys. An hourly rebuild bounds how wrong the page can get.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: "Events",
  description:
    "General body meetings, recruiter resume workshops, socials, Taste of SASE, and national conference delegations. Open to all Georgia Tech students unless noted.",
  path: "/events",
});

export default function EventsPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Events", "/events")} />
      {/* Only upcoming events get a graph — Google drops past-dated Event
          results anyway, and emitting them invites "expired event" warnings. */}
      {upcomingEvents.map((event) => (
        <JsonLd key={event.title} data={eventSchema(event)} />
      ))}
      <PageHeader
        eyebrow="Calendar"
        title="Events."
        body="General body meetings, workshops, socials, and conferences. Open to all Georgia Tech students unless noted."
      />

      <Section eyebrow="Upcoming" title="On the calendar now.">
        {upcomingEvents.length > 0 ? (
          <div className="stagger grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingEvents.map((event) => (
              <EventCard key={event.title} event={event} />
            ))}
          </div>
        ) : (
          <Card className="max-w-measure">
            <h3 className="font-display text-navy text-h3 font-bold">
              Between semesters.
            </h3>
            <p className="text-ink-muted text-body-sm mt-3 leading-relaxed">
              Next semester&apos;s calendar goes up before classes start. Follow
              the feeds for room announcements in the meantime.
            </p>
          </Card>
        )}
      </Section>

      <Section
        id="past"
        eyebrow="Archive"
        title="What we ran last year."
        tone="cream"
      >
        <ul role="list" className="divide-hairline divide-y">
          {pastEvents.map((event) => (
            <li
              key={event.title}
              className="grid gap-3 py-8 sm:grid-cols-[minmax(0,180px)_1fr]"
            >
              <p className="text-ink-muted text-eyebrow tracking-caps font-semibold uppercase">
                {event.displayDate}
                <span className="mt-1 block">{event.location}</span>
              </p>
              <div className="min-w-0">
                <h3 className="font-display text-navy text-h3 font-bold">
                  {event.title}
                </h3>
                <p className="text-ink-muted text-body mt-2 break-words leading-relaxed">
                  {event.body}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      {/* Closing band — the calendar is placeholder, so point at the feeds. */}
      <Section size="sm">
        <CtaPanel
          title="Room announcements go out weekly."
          body="Dates and rooms shift during the semester. The feed carries every update first, and members get the calendar in their inbox."
        >
          <Button href="/join">Become a member</Button>
          {instagram && (
            <Button href={instagram.href} variant="ghost" external>
              Follow on {instagram.label}
            </Button>
          )}
        </CtaPanel>
      </Section>
    </>
  );
}
