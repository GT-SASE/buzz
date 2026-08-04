import {
  Button,
  CtaPanel,
  Eyebrow,
  PageHeader,
  PhotoFrame,
  PillarGrid,
  Section,
} from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
import { board, missionPillars, stats } from "~/data/content";
import { photos } from "~/data/photos";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "About",
  description:
    "SASE at Georgia Tech is the campus chapter of the Society of Asian Scientists and Engineers. Our mission, how the chapter is run, and what a year here looks like.",
  path: "/about",
});

/** "President, Internal Vice President, ... and Web Development Chair" */
function roleSentence(roles: string[]) {
  if (roles.length < 2) return roles.join("");
  return `${roles.slice(0, -1).join(", ")}, and ${roles[roles.length - 1]}`;
}

export default function AboutPage() {
  const roles = roleSentence(board.map((member) => member.role));

  return (
    <>
      <JsonLd data={breadcrumbSchema("About", "/about")} />
      <PageHeader
        eyebrow="Who we are"
        title="About SASE GT."
        body="The Georgia Tech chapter of the Society of Asian Scientists and Engineers — a national nonprofit serving Asian heritage students and professionals in STEM."
      />

      <Section
        eyebrow="Our mission"
        title="What we are here to do."
        size="lg"
        layout="split"
      >
        <PillarGrid pillars={missionPillars} />

        <div className="mt-16 grid gap-4 sm:grid-cols-2">
          <PhotoFrame
            photo={photos.workshop}
            sizes="(min-width: 640px) 36rem, 100vw"
            className="aspect-[4/3]"
          />
          <PhotoFrame
            photo={photos.serviceCards}
            sizes="(min-width: 640px) 36rem, 100vw"
            className="aspect-[4/3]"
          />
        </div>
      </Section>

      <Section
        eyebrow="History"
        title="Where the organization came from."
        size="md"
        tone="cream"
      >
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="text-ink-muted max-w-measure text-lead space-y-6 leading-[1.65]">
            <p>
              SASE was founded nationally in November 2007 to serve Asian
              heritage scientists and engineers, joining organizations like
              NSBE, SHPE, and SWE in advancing diversity across STEM.
            </p>
            <p>
              {/* TODO: replace with the real chapter history and founding year. */}
              The Georgia Tech chapter followed. It is run by an elected
              executive board — {roles} — with committees forming around each of
              those portfolios. Elections are held every spring, and any member
              can run.
            </p>
            <p>
              A year here follows the same spine: a fall kickoff general body
              meeting, a resume workshop with our corporate partners,
              mentor/mentee pairing for the semester, a chapter delegation to
              the SASE National Convention, and Taste of SASE in the spring.
              Between those are weekly meetings, technical projects, service
              with Atlanta-area students, and socials.
            </p>
            <p>
              Membership is open to all Georgia Tech students regardless of
              major, year, or background.
            </p>
          </div>

          {/* Column counts track the number of stats exactly: a leftover cell
              paints the container's own hairline ground as a bare tile. */}
          <dl className="bg-hairline rounded-panel ring-hairline lg:divide-hairline shadow-soft lg:bg-paper grid grid-cols-1 gap-px overflow-hidden ring-1 sm:grid-cols-3 lg:grid-cols-1 lg:gap-0 lg:divide-y">
            {stats.map((stat) => (
              <div
                key={stat.label}
                className="bg-paper flex flex-col-reverse p-6"
              >
                <Eyebrow as="dt" tone="muted" rule={false} className="mt-2">
                  {stat.label}
                </Eyebrow>
                <dd className="font-display text-gold-ink text-stat font-bold">
                  {stat.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section size="sm">
        <CtaPanel
          title="The fastest way to know if this is for you."
          body="Show up once. Membership is free, there is no application, and no prior involvement is assumed."
        >
          <Button href="/join">Come to a general body meeting</Button>
        </CtaPanel>
      </Section>
    </>
  );
}
