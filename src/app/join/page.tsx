import Link from "next/link";

import { Button, PageHeader, Section } from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
import { meeting } from "~/data/content";
import { discord, instagram, site } from "~/data/site";
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
    body: "Officers read out a code at the start of each event. Entering it in the member portal is free, takes a few seconds, and is what earns you chapter points toward the year's tiers.",
    links: [{ label: "Open the member portal", href: "/portal" }],
  },
  {
    title: "Follow the chapter feeds",
    body: "Room changes, corporate info sessions, and internship postings go out on our feeds first — that is where the week-to-week detail lives.",
    links: [instagram, discord]
      .filter((social) => social !== undefined)
      .map((social) => ({
        label: social.label,
        href: social.href,
        external: true,
      })),
  },
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

function StepLinks({ links }: { links: StepLink[] }) {
  if (links.length === 0) return null;
  return (
    <p className="text-body-sm mt-4 flex flex-wrap gap-x-5 gap-y-2 font-semibold">
      {links.map((link) =>
        link.external ? (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-navy"
          >
            {link.label}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <Link key={link.href} href={link.href} className="text-navy">
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
      {/* The three questions below are the ones search actually asks about a
          culture-affiliated org; a FAQPage graph puts the answers in the SERP. */}
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

      {/* The actions sit directly under the header because the steps below
          offer only inline text links, which left this page — the one people
          arrive on ready to act — with nothing clickable above the fold. They
          are the first step and the thing that records it, in that order;
          emailing the board is further down, where a question belongs. */}
      <section className="px-5 pt-12 sm:px-6">
        <div className="max-w-content mx-auto flex flex-wrap gap-4">
          <Button href="/events">Find the next meeting</Button>
          <Button href="/portal" variant="outline">
            Member portal
          </Button>
        </div>
      </section>

      <Section eyebrow="How to join" title="Three steps, none of them hard.">
        <ol
          role="list"
          className="divide-hairline ring-hairline rounded-panel grid divide-y overflow-hidden ring-1 md:grid-cols-3 md:divide-x md:divide-y-0"
        >
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="hover:bg-cream bg-paper p-8 transition"
            >
              <span className="bg-gold block h-0.5 w-8" />
              <span
                aria-hidden="true"
                className="font-display text-navy text-numeral mt-5 block font-bold"
              >
                0{i + 1}
              </span>
              <h3 className="font-display text-navy text-h3 mt-4 font-bold">
                {step.title}
              </h3>
              <p className="text-ink-muted text-body-sm mt-3 leading-relaxed">
                {step.body}
              </p>
              <StepLinks links={step.links} />
            </li>
          ))}
        </ol>
      </Section>

      <Section
        eyebrow="Questions"
        title="Before you ask."
        lead="If the answer you need is not here, email the chapter — someone on the board reads it."
        layout="split"
        tone="cream"
      >
        <dl>
          {faqs.map((faq) => (
            <div
              key={faq.q}
              className="border-hairline gap-x-8 border-t py-7 sm:grid sm:grid-cols-[minmax(0,15rem)_1fr]"
            >
              <dt className="font-display text-navy text-h3 font-bold">
                {faq.q}
              </dt>
              <dd className="text-ink-muted text-body mt-3 leading-relaxed sm:mt-0">
                {faq.a}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section eyebrow="Stay in touch" title="Find us here." size="sm">
        <div className="flex flex-wrap gap-3">
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
