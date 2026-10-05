import { Button, PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { getCommitteeRecruiting } from "~/data/committee-recruiting";
import { committeeExpectations, committees } from "~/data/committees";
import { discord } from "~/data/site";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Website Team | SASE at Georgia Tech",
  description:
    "Join the SASE at Georgia Tech website team. Build the chapter site and Buzz, the member portal. Any experience level.",
  path: "/website-team",
});

const team = committees.find((committee) => committee.id === "website")!;

export default async function WebsiteTeamPage() {
  const recruiting = await getCommitteeRecruiting();

  return (
    <>
      <JsonLd data={breadcrumbSchema("Website Team", "/website-team")} />
      <PageHeader title="Join the website team." body={team.blurb} />

      <Section
        size="sm"
        layout="split"
        title="What you do."
        lead={
          recruiting?.open
            ? `Recruiting for ${recruiting.label}. Applications close ${recruiting.closesLabel}.`
            : "The team recruits once a semester. Applications open in the portal when the board announces them."
        }
      >
        <ul role="list" className="border-hairline border-t">
          {team.responsibilities.map((item) => (
            <li key={item} className="border-hairline border-b py-5">
              <p className="text-navy text-body font-semibold">{item}</p>
            </li>
          ))}
        </ul>
        <ul className="text-ink-muted text-body-sm mt-10 grid gap-2 sm:grid-cols-2">
          {committeeExpectations.map((item) => (
            <li key={item} className="flex gap-3">
              <span
                aria-hidden="true"
                className="bg-gold-bright mt-1.5 size-1.5 shrink-0 rounded-full"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <div className="mt-10 flex flex-wrap gap-4">
          {recruiting?.open ? (
            <Button
              href="/portal/committees?committee=website"
              className="w-full justify-center sm:w-auto"
            >
              Apply in the portal
            </Button>
          ) : (
            discord && (
              <Button
                href={discord.href}
                external
                className="w-full justify-center sm:w-auto"
              >
                Watch the Discord
              </Button>
            )
          )}
        </div>
      </Section>
    </>
  );
}
