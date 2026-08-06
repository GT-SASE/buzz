import { Button, Icon, PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/components/ui/accordion";
import { programs } from "~/data/content";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Programs",
  description:
    "Six standing programs at SASE Georgia Tech: professional development, mentor families, technical projects, community service, socials, and national conferences.",
  path: "/programs",
});

function numeral(index: number) {
  return String(index + 1).padStart(2, "0");
}

export default function ProgramsPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Programs", "/programs")} />
      <PageHeader
        eyebrow="Programs"
        title="What a semester here looks like."
        body="Six standing programs run every semester. Members pick as many or as few as they want — nothing below is all-or-nothing."
      />

      <Section size="sm">
        <Accordion
          type="single"
          collapsible
          className="rule-heavy border-hairline border-b"
        >
          {programs.map((program, i) => (
            <AccordionItem
              key={program.slug}
              id={program.slug}
              value={program.slug}
              className="border-hairline rounded-none"
            >
              <AccordionTrigger className="[&>svg]:text-gold-ink items-center gap-6 rounded-none py-7 hover:no-underline">
                <span className="grid flex-1 gap-x-16 gap-y-4 lg:grid-cols-[1.35fr_1fr] lg:items-center">
                  <span className="flex items-center gap-5 sm:gap-8">
                    <span
                      aria-hidden="true"
                      className="text-numeral tracking-caps text-gold-ink font-semibold"
                    >
                      {numeral(i)}
                    </span>
                    <Icon
                      name={program.icon}
                      className="text-gold-ink size-7 shrink-0"
                    />
                    <span className="font-display text-navy text-h3 font-bold">
                      {program.title}
                    </span>
                  </span>
                  <span className="text-ink-muted text-body-sm leading-relaxed font-normal">
                    {program.body}
                  </span>
                </span>
              </AccordionTrigger>
              {/* pr-10 clears the trigger's chevron so the detail lines up under
                  the summary it expands. */}
              <AccordionContent className="grid gap-x-16 pb-10 lg:grid-cols-[1.35fr_1fr] lg:pr-10">
                <p className="text-ink-muted text-body max-w-measure leading-relaxed lg:col-start-2">
                  {program.detail}
                </p>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Section>

      <Section
        size="sm"
        tone="cream"
        title="Pick one and show up."
        lead="Every program starts at a general body meeting."
      >
        <Button href="/join">Join SASE</Button>
      </Section>
    </>
  );
}
