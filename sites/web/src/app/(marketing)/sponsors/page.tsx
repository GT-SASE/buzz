import { Check } from "lucide-react";

import {
  Button,
  Card,
  CtaPanel,
  Eyebrow,
  PageHeader,
  Section,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { SponsorWall } from "~/components/site/sponsor-wall";
import {
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Card as UiCard,
} from "~/components/ui/card";
import { sponsorTiers } from "~/data/content";
import { site } from "~/data/site";
import { packetAction, sponsors } from "~/data/sponsors";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";
import { withOwnShareImage } from "~/lib/own-share-image";
import { schoolYear } from "@buzz/api/terms";

// The school year below rolls over on its own, without a deploy.
export const revalidate = 3600;

export const metadata = withOwnShareImage(
  pageMetadata({
    title: "Sponsors | SASE at Georgia Tech",
    description:
      "Sponsor SASE at Georgia Tech and recruit from hundreds of Georgia Tech engineering, computing, science, and business students. Tiers, perks, and how to start.",
    path: "/sponsors",
  }),
);

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
  // react-doctor-disable-next-line react-doctor/rendering-hydration-mismatch-time -- server component, the school year is computed once on the server
  const year = schoolYear(new Date());
  const packet = packetAction();
  const hasPartners = sponsors.length > 0;

  return (
    <>
      <JsonLd data={breadcrumbSchema("Sponsors", "/sponsors")} />
      <PageHeader
        title="Sponsors."
        body="Sponsoring SASE GT puts your company in front of hundreds of Georgia Tech students in engineering, computing, and the sciences."
      />

      {/* Until there are logos the page invites the first partner instead: an
          empty wall advertises that the chapter has none. */}
      {hasPartners && (
        <Section
          eyebrow={year}
          title="Our partners."
          lead="The companies that recruit with and support SASE GT this year."
          size="sm"
        >
          <SponsorWall sponsors={sponsors} />
        </Section>
      )}

      <Section
        eyebrow={hasPartners ? undefined : year}
        title={
          hasPartners ? "Why partner with SASE GT." : "Partner slots are open."
        }
        lead={
          hasPartners
            ? "Early partners choose their event first."
            : "The chapter is building its corporate partner roster for the coming year."
        }
      >
        <dl className="grid gap-x-10 gap-y-12 md:grid-cols-3">
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

      {!hasPartners && (
        <Section size="sm">
          <CtaPanel
            eyebrow="Open to every company"
            title="Become our first partner."
            body="Early partners choose their event first. Tell us what you are recruiting for and the officer who handles corporate relations will pick it up."
          >
            <Button
              href={`mailto:${site.email}?subject=${encodeURIComponent("Becoming a SASE GT partner")}`}
              variant="solid"
            >
              Start the conversation
            </Button>
            <Button href="#tiers" variant="ghost">
              See the tiers
            </Button>
          </CtaPanel>
        </Section>
      )}

      <Section id="tiers" title="Pick a level, or ask for something custom.">
        <ul role="list" className="grid gap-8 lg:grid-cols-3">
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
                  <p className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
                    {tier.amount}
                  </p>
                  <p className="text-eyebrow tracking-caps text-ink-muted border-hairline mt-4 border-t pt-4 font-semibold uppercase">
                    Includes
                  </p>
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
                    variant={i === 0 ? "primary" : "outline"}
                    className={i === 0 ? "w-full justify-center" : undefined}
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
            href={packet.href}
            external={packet.external}
            className="mt-7 w-full justify-center sm:w-auto"
          >
            {packet.label}
          </Button>
          <p className="text-body-sm text-ink-muted mt-6">
            Custom packages and single-event sponsorships are available. Mention
            what you are recruiting for at {site.email}.
          </p>
        </div>
      </Section>
    </>
  );
}
