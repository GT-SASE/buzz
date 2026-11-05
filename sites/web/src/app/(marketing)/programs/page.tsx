import { Button, Icon, PageHeader, Section } from "~/components/site";
import { Disclosure } from "~/components/site/disclosure";
import { JsonLd } from "~/components/site/json-ld";
import { programs } from "~/data/content";
import { joinHref } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Programs | SASE at Georgia Tech",
  description:
    "Six standing programs at SASE Georgia Tech: professional development, SASE KIN, technical projects, community service, socials, and national conferences.",
  path: "/programs",
});

export default function ProgramsPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Programs", "/programs")} />
      <PageHeader
        title="What a semester here looks like."
        body="Six standing programs run every semester. Members pick as many or as few as they want."
      />

      <Section size="sm">
        <h2 className="sr-only">Programs</h2>
        <div className="rule-heavy border-hairline border-b">
          {programs.map((program) => (
            <Disclosure
              key={program.slug}
              id={program.slug}
              name="programs"
              className="border-hairline rounded-none"
              summaryClassName="[&>svg]:text-gold-ink items-center gap-6 rounded-none py-7"
              // pr-10 clears the summary's chevron so the detail lines up under
              // the summary it expands.
              panelClassName="grid gap-x-16 pb-10 lg:grid-cols-[1.35fr_1fr] lg:pr-10"
              summary={
                <span className="grid min-w-0 flex-1 gap-x-16 gap-y-4 lg:grid-cols-[1.35fr_1fr] lg:items-center">
                  <span className="flex min-w-0 items-center gap-5 sm:gap-8">
                    <span
                      aria-hidden="true"
                      className="hex-face bg-gold-bright size-3 shrink-0"
                    />
                    <Icon
                      name={program.icon}
                      className="text-gold-ink size-7 shrink-0"
                    />
                    <span className="font-display text-navy text-h3 min-w-0 font-bold">
                      {program.title}
                    </span>
                  </span>
                  <span className="text-ink-muted text-body-sm hidden leading-relaxed font-normal lg:block">
                    {program.body}
                  </span>
                </span>
              }
            >
              <div className="grid gap-5 lg:col-start-2">
                <p className="text-ink-muted text-body max-w-measure leading-relaxed">
                  {program.detail}
                </p>
                {program.slug === "mentorship" && (
                  <Button
                    href="/portal/mentorship"
                    className="w-full justify-center sm:w-auto"
                  >
                    Join a SASE KIN group
                  </Button>
                )}
              </div>
            </Disclosure>
          ))}
        </div>
      </Section>

      <Section
        size="sm"
        tone="paper"
        title="Pick one and show up."
        lead="Every program starts at a general body meeting."
      >
        <Button href={joinHref} className="w-full justify-center sm:w-auto">
          Join SASE
        </Button>
      </Section>
    </>
  );
}
