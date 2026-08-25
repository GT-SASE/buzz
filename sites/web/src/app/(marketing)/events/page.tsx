import {
  Button,
  CtaPanel,
  EventCard,
  PageHeader,
  Section,
  TextLink,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { getChapterEvents } from "~/data/chapter-events";
import { instagram } from "~/data/site";
import { breadcrumbSchema, eventSchema, pageMetadata } from "~/lib/seo";

// Hourly: an event published in the portal appears without a deploy.
export const revalidate = 3600;

export const metadata = pageMetadata({
  title: "Events",
  description:
    "General body meetings, recruiter resume workshops, socials, Taste of SASE, and national conference delegations. Open to all Georgia Tech students unless noted.",
  path: "/events",
});

function EmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Alert
      role="note"
      className="border-hairline bg-cream border-t-gold max-w-measure gap-y-3 rounded-xl border-t-2 px-6 py-7"
    >
      <AlertTitle className="font-display text-navy text-h3 line-clamp-none font-bold">
        {title}
      </AlertTitle>
      <AlertDescription className="text-ink-muted text-body-sm gap-3 leading-relaxed">
        {children}
      </AlertDescription>
    </Alert>
  );
}

export default async function EventsPage() {
  const { upcoming, past } = await getChapterEvents();

  return (
    <>
      <JsonLd data={breadcrumbSchema("Events", "/events")} />
      {/* Only upcoming events get a graph — Google drops past-dated Event
          results anyway, and emitting them invites "expired event" warnings. */}
      {upcoming.map((event) => (
        <JsonLd key={event.id} data={eventSchema(event)} />
      ))}
      <PageHeader
        eyebrow="Calendar"
        title="Events."
        body="General body meetings, workshops, socials, and conferences. Open to all Georgia Tech students unless noted."
      />

      <Section eyebrow="Upcoming" title="On the calendar now.">
        {upcoming.length > 0 ? (
          <div className="stagger grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {upcoming.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        ) : (
          <EmptyState title="Nothing scheduled yet.">
            <p>
              The calendar is empty on purpose — dates go up here as soon as the
              board has rooms confirmed. Announcements go out on the feeds
              first.
            </p>
            {instagram && (
              <TextLink href={instagram.href} external>
                Follow on {instagram.label}
              </TextLink>
            )}
          </EmptyState>
        )}

        <div className="border-hairline mt-14 border-t pt-6">
          <TextLink href="/events#past">See what we ran last year</TextLink>
        </div>
      </Section>

      {/* The site nav links straight to #past, so the section renders even when
          the archive is empty rather than dropping the anchor. */}
      <Section
        id="past"
        eyebrow="Archive"
        title="What we ran last year."
        tone="cream"
      >
        {past.length > 0 ? (
          <ul
            role="list"
            className="border-hairline divide-hairline divide-y border-y"
          >
            {past.map((event) => (
              <li
                key={event.id}
                className="grid gap-x-10 gap-y-3 py-8 sm:grid-cols-[minmax(0,15rem)_1fr]"
              >
                <div>
                  <p className="text-ink-muted text-eyebrow tracking-masthead font-semibold uppercase">
                    {event.displayDate}
                  </p>
                  {event.location && (
                    <Badge
                      variant="outline"
                      className="border-hairline text-ink-muted text-body-sm mt-2 rounded-md px-2.5 py-1 font-normal"
                    >
                      {event.location}
                    </Badge>
                  )}
                </div>
                <div className="min-w-0">
                  <h3 className="font-display text-navy text-h3 font-bold">
                    {event.title}
                  </h3>
                  {event.description && (
                    <p className="text-ink-muted text-body mt-2 leading-relaxed break-words">
                      {event.description}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="The archive fills itself.">
            <p>
              Nothing has passed yet. Events move here on their own once the
              date is behind us, so this page is never a dead end.
            </p>
            <TextLink href="/join">Join the chapter</TextLink>
          </EmptyState>
        )}
      </Section>

      <Section size="sm">
        <CtaPanel
          title="Room announcements go out weekly."
          body="Dates and rooms shift during the semester. The feed carries every update first, and members get the calendar in their inbox."
        >
          <Button href="/join" variant="solid">
            Become a member
          </Button>
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
