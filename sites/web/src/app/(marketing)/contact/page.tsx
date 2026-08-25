import {
  Button,
  Card,
  CtaPanel,
  PageHeader,
  Section,
  TextLink,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Badge } from "~/components/ui/badge";
import { meeting } from "~/data/content";
import { discord, instagram, site } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Contact",
  description:
    "How to reach SASE at Georgia Tech: general body meetings for prospective members, Discord and the mailing list for members, and sponsorship contacts for companies.",
  path: "/contact",
});

const meetingRows = [
  { term: "Cadence", detail: meeting.cadence },
  { term: "Day", detail: meeting.day },
  { term: "Time", detail: meeting.time },
  { term: "Where", detail: meeting.location },
];

const mailingListHref = `mailto:${site.email}?subject=${encodeURIComponent("Mailing list")}`;

function ChannelBadge({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className="text-eyebrow tracking-caps uppercase">
      {children}
    </Badge>
  );
}

export default function ContactPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Contact", "/contact")} />
      <PageHeader
        eyebrow="Contact"
        title="Reach the chapter."
        body="Three ways in, depending on who you are. Everything here goes to the executive board."
      />

      <Section
        id="prospective"
        eyebrow="Prospective members"
        title="Start at a general body meeting."
        lead="Nothing is required to attend. Membership is free, there is no application, and there is no major requirement. Come once and decide from there."
        layout="split"
      >
        <Card>
          <div className="flex flex-wrap items-center gap-4">
            <h3 className="font-display text-navy text-h3 font-bold">
              General body meetings
            </h3>
            <ChannelBadge>{meeting.cadence}</ChannelBadge>
          </div>

          <dl className="border-hairline mt-6 border-b">
            {meetingRows.map((row) => (
              <div
                key={row.term}
                className="border-hairline flex flex-wrap gap-x-10 gap-y-1 border-t py-4"
              >
                <dt className="text-eyebrow tracking-masthead text-ink-muted w-32 shrink-0 pt-1 font-semibold uppercase">
                  {row.term}
                </dt>
                <dd className="text-ink text-body">{row.detail}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-10 flex flex-wrap items-center gap-x-8 gap-y-4">
            {instagram && (
              <Button href={instagram.href} variant="outline" external>
                {instagram.label}
              </Button>
            )}
            <Button href="/events" variant="outline">
              Upcoming events
            </Button>
          </div>
        </Card>
      </Section>

      <Section
        id="members"
        eyebrow="Current members"
        title="Day-to-day channels."
        size="sm"
      >
        <div className="grid gap-x-12 gap-y-12 md:grid-cols-2">
          <Card className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-4">
              <h3 className="font-display text-navy text-h3 font-bold">
                Discord
              </h3>
              <ChannelBadge>Fastest reply</ChannelBadge>
            </div>
            <p className="text-ink-muted text-body mt-5 leading-relaxed">
              Room changes, project team channels, ride shares to conferences,
              and the fastest way to get an answer from a chair.
            </p>
            {discord && (
              <p className="mt-6">
                <TextLink href={discord.href} external>
                  Open the server
                </TextLink>
              </p>
            )}
          </Card>

          <Card className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-4">
              <h3 className="font-display text-navy text-h3 font-bold">
                Mailing list
              </h3>
              <ChannelBadge>Weekly digest</ChannelBadge>
            </div>
            <p className="text-ink-muted text-body mt-5 leading-relaxed">
              A weekly digest of events, corporate info sessions, and internship
              postings. Email the chapter inbox to be added, or sign up at any
              general body meeting.
            </p>
            <p className="mt-6">
              <TextLink href={mailingListHref}>{site.email}</TextLink>
            </p>
          </Card>
        </div>
      </Section>

      <Section id="partners" size="sm">
        <CtaPanel
          eyebrow="Corporate partners"
          title="Recruit from this chapter."
          body="Info sessions, technical workshops, resume book access, and named sponsorship of a signature event. Write to the chapter inbox and the external vice president will follow up."
        >
          <Button
            variant="solid"
            href={`mailto:${site.email}?subject=${encodeURIComponent("Sponsorship packet request")}`}
          >
            Request the sponsorship packet
          </Button>
          <Button href="/sponsors" variant="ghost">
            See the tiers
          </Button>
          <p className="text-body-sm w-full text-white/60">{site.email}</p>
        </CtaPanel>
      </Section>
    </>
  );
}
