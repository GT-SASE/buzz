import {
  Button,
  Card,
  CtaPanel,
  Eyebrow,
  PageHeader,
  Section,
} from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
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
        <dl className="border-hairline border-t">
          {meetingRows.map((row) => (
            <div
              key={row.term}
              className="border-hairline flex flex-wrap gap-x-8 gap-y-1 border-b py-4"
            >
              <Eyebrow as="dt" rule={false} className="w-32 shrink-0 pt-1">
                {row.term}
              </Eyebrow>
              <dd className="text-ink-muted text-body">{row.detail}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-8 flex flex-wrap gap-3">
          {instagram && (
            <Button href={instagram.href} variant="outline" external>
              {instagram.label}
            </Button>
          )}
          <Button href="/events" variant="outline">
            Upcoming events
          </Button>
        </div>
      </Section>

      <Section
        id="members"
        eyebrow="Current members"
        title="Day-to-day channels."
        tone="cream"
        size="sm"
      >
        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <h3 className="font-display text-navy text-h3 font-bold">
              Discord
            </h3>
            <p className="text-ink-muted text-body-sm mt-3 leading-relaxed">
              Room changes, project team channels, ride shares to conferences,
              and the fastest way to get an answer from a chair.
            </p>
            {discord && (
              <p className="mt-5">
                <a
                  href={discord.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-navy text-body-sm font-semibold"
                >
                  Open the server
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </p>
            )}
          </Card>

          <Card>
            <h3 className="font-display text-navy text-h3 font-bold">
              Mailing list
            </h3>
            <p className="text-ink-muted text-body-sm mt-3 leading-relaxed">
              A weekly digest of events, corporate info sessions, and internship
              postings. Email the chapter inbox to be added, or sign up at any
              general body meeting.
            </p>
            <p className="mt-5">
              <a
                href={`mailto:${site.email}?subject=${encodeURIComponent("Mailing list")}`}
                className="text-navy text-body-sm font-semibold"
              >
                {site.email}
              </a>
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
            href={`mailto:${site.email}?subject=${encodeURIComponent("Sponsorship packet request")}`}
          >
            Request the sponsorship packet
          </Button>
          <Button href="/sponsors" variant="ghost">
            See the tiers
          </Button>
          {/* `w-full` drops the address onto its own line below the buttons,
              since the panel gives its children one wrapping flex row. */}
          <p className="text-body-sm w-full text-white/60">{site.email}</p>
        </CtaPanel>
      </Section>
    </>
  );
}
