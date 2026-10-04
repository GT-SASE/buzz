import {
  Button,
  CtaPanel,
  PageHeader,
  PhotoFrame,
  PillarGrid,
  Section,
} from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { board, missionPillars } from "~/data/content";
import { photos } from "~/data/photos";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "About | SASE at Georgia Tech",
  description:
    "SASE at Georgia Tech is the campus chapter of the Society of Asian Scientists and Engineers. Our mission, how the chapter is run, and what a year looks like.",
  path: "/about",
});

/** "President, Internal Vice President, ... and Marketing Director" */
function roleSentence(roles: string[]) {
  const unique = [...new Set(roles)];
  if (unique.length < 2) return unique.join("");
  return `${unique.slice(0, -1).join(", ")}, and ${unique[unique.length - 1]}`;
}

export default function AboutPage() {
  const roles = roleSentence(board.map((member) => member.role));

  return (
    <>
      <JsonLd data={breadcrumbSchema("About", "/about")} />
      <PageHeader
        title="About SASE GT."
        body="The Georgia Tech chapter of the Society of Asian Scientists and Engineers, a national nonprofit serving Asian heritage students and professionals in STEM."
      />

      <Section title="What we are here to do." size="lg">
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

      <Section title="Where the organization came from." size="md">
        <div>
          <div className="text-ink-muted max-w-measure text-lead space-y-6 leading-[1.65]">
            <p>
              SASE was founded nationally in November 2007 to serve Asian
              heritage scientists and engineers, joining organizations like
              NSBE, SHPE, and SWE in advancing diversity across STEM.
            </p>
            <p>
              Founded in 2007, the Georgia Tech chapter is one of the oldest
              SASE collegiate chapters in the nation. It is run by an elected
              executive board ({roles}), with committees forming around each of
              those portfolios. Elections are held every spring, and any member
              can run.
            </p>
            <p>
              A year here follows the same spine: a fall kickoff general body
              meeting, professional development workshops with industry
              partners, a new SASE KIN group each semester, a chapter delegation
              to the SASE National Convention, and the spring banquet. Between
              those are general body meetings, technical projects, service with
              Atlanta-area students, and socials. The chapter hosted the SASE
              Southeast Regional Conference in 2017 and 2019.
            </p>
            <p>
              Membership is open to all Georgia Tech students regardless of
              major, year, or background.
            </p>
          </div>
        </div>
      </Section>

      <Section size="sm">
        <CtaPanel
          title="The fastest way to know if this is for you."
          body="Show up once. Membership is free, there is no application, and no prior involvement is assumed."
        >
          <Button href="/join" variant="solid">
            Come to a meeting
          </Button>
        </CtaPanel>
      </Section>
    </>
  );
}
