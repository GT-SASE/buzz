import {
  Button,
  Card,
  Eyebrow,
  PageHeader,
  Section,
} from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
import { sponsorTiers } from "~/data/content";
import { site } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Sponsors",
  description:
    "Sponsor SASE at Georgia Tech and recruit from hundreds of Georgia Tech engineering, computing, science, and business students. Tiers, perks, and how to start.",
  path: "/sponsors",
});

const reach = [
  {
    label: "Who you reach",
    body: "Undergraduates and graduate students across computing, every engineering discipline, the sciences, and Scheller business.",
  },
  {
    label: "How we deliver",
    body: "Info sessions, technical workshops, resume book access, and named sponsorship of a signature chapter event.",
  },
  {
    label: "When to start",
    body: "Fall recruiting slots are set over the summer. Spring slots are set in December.",
  },
];

export default function SponsorsPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Sponsors", "/sponsors")} />
      <PageHeader
        eyebrow="Partner with us"
        title="Sponsors."
        body="Sponsoring SASE GT puts your company in front of hundreds of Georgia Tech students in engineering, computing, and the sciences."
      />

      {/* No logo wall until there are logos — an empty one advertises that the
          chapter has no partners. This says the same thing as an invitation. */}
      <Section
        eyebrow="2026-2027"
        title="Partner slots are open."
        lead="The chapter is building its corporate partner roster for the coming year. Early partners choose their event first."
      >
        <dl className="stagger grid gap-8 md:grid-cols-3">
          {reach.map((item) => (
            <div key={item.label} className="border-gold/50 border-t-2 pt-6">
              <Eyebrow as="dt" tone="gold" rule={false}>
                {item.label}
              </Eyebrow>
              <dd className="text-ink-muted text-body mt-4">{item.body}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section
        size="lg"
        layout="split"
        eyebrow="Tiers"
        title="Pick a level, or ask for something custom."
        tone="cream"
      >
        {/* Three columns wait for xl: at lg: the split header still takes the
            container's left rail and the amounts cannot fit. */}
        <div className="stagger grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {sponsorTiers.map((tier, i) => (
            <Card
              key={tier.tier}
              tone={i === 0 ? "navy" : "paper"}
              className="flex flex-col"
            >
              <Eyebrow as="h3" tone={i === 0 ? "light" : "gold"} rule={false}>
                {tier.tier}
              </Eyebrow>
              <p
                className={`font-display text-h2 mt-4 font-bold ${
                  i === 0 ? "text-white" : "text-navy"
                }`}
              >
                {tier.amount}
              </p>
              <ul
                role="list"
                className={`text-body-sm mt-7 space-y-3 ${
                  i === 0 ? "text-white/75" : "text-ink-muted"
                }`}
              >
                {tier.perks.map((perk) => (
                  <li key={perk} className="flex gap-3">
                    <span
                      aria-hidden="true"
                      className="bg-gold-bright mt-2 h-1.5 w-1.5 shrink-0 rounded-full"
                    />
                    {perk}
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        <div className="mt-12">
          <p className="text-lead text-ink-muted max-w-measure">
            Every tier is negotiable. Write to the chapter inbox and the officer
            who handles corporate relations will pick it up.
          </p>
          <Button
            href={`mailto:${site.email}?subject=${encodeURIComponent("Sponsorship packet")}`}
            className="mt-7"
          >
            Request the sponsorship packet
          </Button>
          <p className="text-body-sm text-ink-muted mt-4">
            Custom packages and single-event sponsorships are available —
            mention what you are recruiting for at {site.email}.
          </p>
        </div>
      </Section>
    </>
  );
}
