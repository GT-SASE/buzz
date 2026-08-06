import { Check } from "lucide-react";

import { Button, Card, Eyebrow, PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { Badge } from "~/components/ui/badge";
import {
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "~/components/ui/card";
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
          chapter has no partners. */}
      <Section
        number="01"
        eyebrow="2026-2027"
        title="Partner slots are open."
        lead="The chapter is building its corporate partner roster for the coming year. Early partners choose their event first."
      >
        <dl className="stagger grid gap-x-10 gap-y-12 md:grid-cols-3">
          {reach.map((item) => (
            <Card key={item.label}>
              <Eyebrow as="dt" tone="gold" rule={false}>
                {item.label}
              </Eyebrow>
              <dd className="text-ink-muted text-body mt-4">{item.body}</dd>
            </Card>
          ))}
        </dl>
      </Section>

      <Section
        size="lg"
        number="02"
        eyebrow="Tiers"
        title="Pick a level, or ask for something custom."
      >
        <ul role="list" className="stagger grid gap-8 lg:grid-cols-3">
          {sponsorTiers.map((tier, i) => (
            <li key={tier.tier} className="flex">
              <UiCard
                className={
                  i === 0
                    ? "border-navy/45 flex-1 rounded-lg border-2 shadow-none"
                    : "border-hairline flex-1 rounded-lg shadow-none"
                }
              >
                <CardHeader>
                  <CardTitle className="text-eyebrow tracking-masthead text-gold-ink font-semibold uppercase">
                    {tier.tier}
                  </CardTitle>
                  <CardAction>
                    <Badge
                      variant={i === 0 ? "default" : "secondary"}
                      className="font-display text-body-sm px-3 py-1 font-bold"
                    >
                      {tier.amount}
                    </Badge>
                  </CardAction>
                  <CardDescription>
                    {tier.perks.length} inclusions
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex-1">
                  <ul
                    role="list"
                    className="divide-hairline text-ink-muted text-body divide-y"
                  >
                    {tier.perks.map((perk) => (
                      <li key={perk} className="flex gap-3 py-3 first:pt-0">
                        <Check
                          aria-hidden="true"
                          className="text-gold-ink mt-1 size-4 shrink-0"
                        />
                        <span>{perk}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
                <CardFooter>
                  <Button
                    href={`mailto:${site.email}?subject=${encodeURIComponent(`${tier.tier} tier sponsorship`)}`}
                    variant="outline"
                  >
                    Start with {tier.tier}
                  </Button>
                </CardFooter>
              </UiCard>
            </li>
          ))}
        </ul>

        <div className="max-w-measure mt-14">
          <p className="text-lead text-ink-muted">
            Every tier is negotiable. Write to the chapter inbox and the officer
            who handles corporate relations will pick it up.
          </p>
          <Button
            href={`mailto:${site.email}?subject=${encodeURIComponent("Sponsorship packet")}`}
            className="mt-7"
          >
            Request the sponsorship packet
          </Button>
          <p className="text-body-sm text-ink-muted mt-6">
            Custom packages and single-event sponsorships are available —
            mention what you are recruiting for at {site.email}.
          </p>
        </div>
      </Section>
    </>
  );
}
