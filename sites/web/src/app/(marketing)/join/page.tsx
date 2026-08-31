import Link from "next/link";

import { Button, Card, PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import { Badge } from "~/components/ui/badge";
import { meeting } from "~/data/content";
import { discord, engage, instagram, site } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Join",
  description:
    "How to join SASE at Georgia Tech in three steps. Membership is free — no application, no dues, and no major requirement.",
  path: "/join",
});

type StepLink = { label: string; href: string; external?: boolean };

const steps: { title: string; body: string; links: StepLink[] }[] = [
  {
    title: "Come to a general body meeting",
    body: `No membership required to show up. ${meeting.summary}`,
    links: [{ label: "See the calendar", href: "/events" }],
  },
  {
    title: "Check in at the door",
    body: "Scan the QR code on the present screen with the member portal. It is free, takes a few seconds, and is what earns you chapter points toward the year's tiers.",
    links: [{ label: "Open the member portal", href: "/portal" }],
  },
  {
    title: "Follow the chapter feeds",
    body: "Room changes, corporate info sessions, and internship postings go out on our feeds first — that is where the week-to-week detail lives.",
    links: [instagram, discord, engage]
      .filter((social) => social !== undefined)
      .map((social) => ({
        label: social.label,
        href: social.href,
        external: true,
      })),
  },
];

const meetingRows = [
  { term: "Cadence", detail: meeting.cadence },
  { term: "Day", detail: meeting.day },
  { term: "Time", detail: meeting.time },
  { term: "Where", detail: meeting.location },
];

const faqs = [
  {
    q: "Do I have to be Asian to join?",
    a: "No. SASE is open to every Georgia Tech student regardless of heritage, major, or year.",
  },
  {
    q: "Do I need a technical major?",
    a: "No. Our members study everything from computer science to business to public policy.",
  },
  {
    q: "What if I join mid-semester?",
    a: "Come anyway. Mentorship pairings and project teams have rolling spots most semesters.",
  },
] as const;

const stepLink =
  "text-navy decoration-gold hover:text-gold-ink underline decoration-2 underline-offset-4 transition";

function StepLinks({ links }: { links: StepLink[] }) {
  if (links.length === 0) return null;
  return (
    <p className="text-body-sm mt-5 flex flex-wrap gap-x-6 gap-y-2 font-semibold">
      {links.map((link) =>
        link.external ? (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className={`${stepLink} inline-flex min-h-11 items-center`}
          >
            {link.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <Link
            key={link.href}
            href={link.href}
            className={`${stepLink} inline-flex min-h-11 items-center`}
          >
            {link.label}
          </Link>
        ),
      )}
    </p>
  );
}

export default function JoinPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Join", "/join")} />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqs.map((faq) => ({
            "@type": "Question",
            name: faq.q,
            acceptedAnswer: { "@type": "Answer", text: faq.a },
          })),
        }}
      />
      <PageHeader
        eyebrow="Get involved"
        title="Join SASE GT."
        body="Open to every Georgia Tech student — any major, any year, any background."
      />

      <section className="px-5 pt-12 sm:px-6">
        <div className="max-w-content mx-auto flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8 sm:gap-y-4">
          <Button href="/events" className="w-full justify-center sm:w-auto">
            Find the next meeting
          </Button>
          <Button
            href="/portal"
            variant="outline"
            className="w-full justify-center sm:w-auto"
          >
            Check in
          </Button>
        </div>
      </section>

      <Section
        number="01"
        eyebrow="How to join"
        title="Three steps, none of them hard."
      >
        <ol
          role="list"
          className="stagger grid gap-x-12 gap-y-14 md:grid-cols-3"
        >
          {steps.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full">
                <span
                  aria-hidden="true"
                  className="text-eyebrow tracking-masthead text-gold-ink block font-semibold"
                >
                  0{i + 1}
                </span>
                <h3 className="font-display text-navy text-h3 mt-8 font-bold">
                  {step.title}
                </h3>
                <p className="text-ink-muted text-body-sm mt-4 leading-relaxed">
                  {step.body}
                </p>
                <StepLinks links={step.links} />
              </Card>
            </li>
          ))}
        </ol>
      </Section>

      <Section
        eyebrow="Cadence and dues"
        title="What the year asks of you."
        lead="One recurring commitment and no invoice. Everything else is opt-in, semester by semester."
        layout="split"
      >
        <div className="grid gap-x-12 gap-y-10 sm:grid-cols-2">
          <Card>
            <h3 className="font-display text-navy text-h3 font-bold">
              General body meetings
            </h3>
            <dl className="border-hairline mt-5 border-b">
              {meetingRows.map((row) => (
                <div
                  key={row.term}
                  className="border-hairline flex flex-wrap gap-x-8 gap-y-1 border-t py-3"
                >
                  <dt className="text-eyebrow tracking-masthead text-ink-muted w-24 shrink-0 pt-1 font-semibold uppercase">
                    {row.term}
                  </dt>
                  <dd className="text-ink text-body-sm">{row.detail}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center gap-4">
              <h3 className="font-display text-navy text-h3 font-bold">Dues</h3>
              <Badge
                variant="secondary"
                className="text-eyebrow tracking-caps uppercase"
              >
                None
              </Badge>
            </div>
            <p className="text-ink-muted text-body-sm mt-5 leading-relaxed">
              Membership is free — no application, no dues, and no major
              requirement. Chapter points come from showing up, not from paying
              in.
            </p>
            <p className="text-body-sm mt-5 font-semibold">
              <Link
                href="/programs"
                className={`${stepLink} inline-flex min-h-11 items-center`}
              >
                See what membership opens up
              </Link>
            </p>
          </Card>
        </div>
      </Section>

      <Section
        eyebrow="Questions"
        title="Before you ask."
        lead="If the answer you need is not here, email the chapter — someone on the board reads it."
        layout="split"
      >
        <Accordion
          type="single"
          collapsible
          className="border-hairline border-t"
        >
          {faqs.map((faq) => (
            <AccordionItem
              key={faq.q}
              value={faq.q}
              className="border-hairline last:border-b"
            >
              <AccordionTrigger className="font-display text-navy text-h3 gap-8 rounded-none py-6 font-bold hover:no-underline">
                {faq.q}
              </AccordionTrigger>
              <AccordionContent className="text-ink-muted text-body max-w-measure pb-8 leading-relaxed">
                {faq.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Section>

      <Section eyebrow="Stay in touch" title="Find us here." size="sm">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          {site.socials.map((social) => (
            <Button
              key={social.id}
              href={social.href}
              variant="outline"
              external
            >
              {social.label}
            </Button>
          ))}
          <Button href={`mailto:${site.email}`}>Email us</Button>
        </div>
      </Section>
    </>
  );
}
