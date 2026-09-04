import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import AdminLoading from "../loading";
import { MembersTable } from "./members-table";
import { RosterMetrics, tierFloors } from "./roster-metrics";

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
  await Promise.all([
    api.member.list({ limit: 25, offset: 0, sort: "points" }),
    api.member.metrics({ tiers: tierFloors }),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="Roster"
        title="Roster"
        body="Who has signed in, what they have earned, when they last came."
      />

      <RosterMetrics />

      <Section size="sm">
        <MembersTable />
      </Section>
    </HydrateClient>
  );
}
