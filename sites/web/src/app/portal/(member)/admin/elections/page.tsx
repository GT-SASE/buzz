import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { Button } from "~/components/ui/button";
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
        title="Officer elections"
        body="Open nominations, approve the ballot, then open voting. Only members with an event check-in this school year can vote. Counts stay hidden until you close voting."
        aside={
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/portal/elections">Run or vote as a member</Link>
          </Button>
        }
      />
      <Section size="sm">
        <ElectionAdmin currentYear={currentYear} />
      </Section>
    </HydrateClient>
  );
}
