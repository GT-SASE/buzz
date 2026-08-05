import { Icon } from "~/app/_components/icons";
import { Button, PageHeader, Section } from "~/app/_components/ui";
import { JsonLd } from "~/app/_components/json-ld";
import { programs } from "~/data/content";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Programs",
  description:
    "Six standing programs at SASE Georgia Tech: professional development, mentor families, technical projects, community service, socials, and national conferences.",
  path: "/programs",
});

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
        <nav aria-label="Programs on this page">
          <ul role="list" className="flex flex-wrap gap-2">
            {programs.map((program) => (
              <li key={program.slug}>
                <a
                  href={`#${program.slug}`}
                  className="ring-hairline text-ink-muted hover:text-navy hover:bg-cream text-body-sm inline-flex items-center rounded-full px-4 py-2 font-medium ring-1 transition"
                >
                  {program.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {/* Sticky-header clearance for these jump targets is already set once
            globally by html { scroll-padding-top } — a scroll-margin here would
            add to it rather than replace it. */}
        <div className="mt-14 space-y-14">
          {programs.map((program) => (
            <article
              key={program.slug}
              id={program.slug}
              className="border-hairline border-t pt-8 lg:grid lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-16"
            >
              <div>
                <Icon name={program.icon} className="text-gold-ink h-8 w-8" />
                <h2 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight">
                  {program.title}
                </h2>
              </div>
              <div className="mt-5 lg:mt-0">
                <p className="text-navy text-lead font-medium leading-relaxed">
                  {program.body}
                </p>
                <p className="text-ink-muted text-body mt-4 leading-relaxed">
                  {program.detail}
                </p>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section size="sm" tone="cream">
        <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
          <div>
            <h2 className="font-display text-navy text-h2 font-bold tracking-tight">
              Pick one and show up.
            </h2>
            <p className="text-ink-muted text-lead mt-3 leading-relaxed">
              Every program starts at a general body meeting.
            </p>
          </div>
          <Button href="/join" className="shrink-0">
            Join SASE
          </Button>
        </div>
      </Section>
    </>
  );
}
