import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import { schoolYear } from "@buzz/api";
import AdminLoading from "../loading";
import { ElectionAdmin } from "./election-admin";

export const metadata: Metadata = { title: "Elections" };

export default function AdminElectionsPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminElectionsBody />
    </Suspense>
  );
}

async function AdminElectionsBody() {
  const currentYear = schoolYear(new Date());
  await Promise.all([
    api.election.list({ year: currentYear }),
    api.election.years(),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="Elections"
        title="Officer elections"
        body="Open nominations, approve the ballot, then open voting. Only members with an event check-in this school year can vote. Counts stay hidden until you close voting."
      />
      <Section size="sm">
        <ElectionAdmin currentYear={currentYear} />
      </Section>
    </HydrateClient>
  );
}
