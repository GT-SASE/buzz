import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { tierFloors } from "~/data/portal";
import { HydrateClient, api } from "~/trpc/server";
import AdminLoading from "../loading";
import { MembersTable } from "./members-table";
import { RosterMetrics } from "./roster-metrics";

export const metadata: Metadata = {
  title: "Roster",
};

export default function AdminMembersPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminMembersBody />
    </Suspense>
  );
}

async function AdminMembersBody() {
  // Prefetch is a speed-up and never throws. If it fails, the table and figures
  // still render and fetch over HTTP — better than the whole roster dying
  // behind the generic portal error card.
  await Promise.all([
    api.member.list.prefetch({ limit: 25, offset: 0, sort: "points" }),
    api.member.metrics.prefetch({ tiers: tierFloors }),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        title="Roster"
        body="Who has signed in, what they have earned, when they last came."
      />

      <div className="flex flex-col">
        <RosterMetrics />

        {/* On a phone the search is the job; the figures can wait. */}
        <Section size="sm" className="order-first md:order-none">
          <MembersTable />
        </Section>
      </div>
    </HydrateClient>
  );
}
