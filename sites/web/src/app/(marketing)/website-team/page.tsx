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

const expectations = committeeExpectations.filter(
  (item) => !item.startsWith("Plan one full event"),
);

export default async function WebsiteTeamPage() {
  const cycle = await getCommitteeRecruiting();
  const recruiting =
    cycle?.open && cycle.committees.some(({ id }) => id === "website")
      ? cycle
      : null;

  return (
    <>
      <JsonLd data={breadcrumbSchema("Website Team", "/website-team")} />
      <PageHeader title="Join the website team." body={team.blurb} />

      <Section size="sm" layout="split" title="What you do.">
        <ol role="list" className="border-hairline border-t">
          {team.responsibilities.map((item, index) => (
            <li key={item} className="border-hairline flex gap-6 border-b py-5">
              <span className="text-gold-ink text-body-sm w-6 shrink-0 pt-0.5 font-semibold tabular-nums">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="text-navy text-body font-semibold">{item}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section size="sm" layout="split" title="What it takes.">
        <ul role="list" className="border-hairline border-t">
          {expectations.map((item) => (
            <li
              key={item}
              className="border-hairline text-ink-muted text-body border-b py-4"
            >
              {item}
            </li>
          ))}
        </ul>
        <p className="text-ink text-body mt-10">
          {recruiting
            ? `Applications for ${recruiting.label} close ${recruiting.closesLabel}.`
            : "The team recruits once a semester. Applications open in the portal when the board announces them on Discord."}
        </p>
        <div className="mt-6">
          {recruiting ? (
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
                Join the Discord
              </Button>
            )
          )}
        </div>
      </Section>
    </>
  );
}
