import { PageHeader, Section } from "~/components/site";
import { JsonLd } from "~/components/site/json-ld";
import { UptimeBoard } from "~/components/site/uptime-board";
import { breadcrumbSchema, pageMetadata } from "~/lib/seo";

export const metadata = pageMetadata({
  title: "Status | SASE at Georgia Tech",
  description:
    "Whether the SASE at Georgia Tech website is up, and its uptime over the last 90 days.",
  path: "/status",
});

export default function StatusPage() {
  return (
    <>
      <JsonLd data={breadcrumbSchema("Status", "/status")} />
      <PageHeader title="Site status." />

      <Section size="sm">
        <UptimeBoard />
      </Section>
    </>
  );
}
