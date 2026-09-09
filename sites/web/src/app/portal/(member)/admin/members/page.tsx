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
  // Prefetch is a speed-up. If it throws, the table and figures still render
  // and fetch over HTTP — better than the whole roster dying behind the
  // generic portal error card.
  let prefetched = false;
  try {
    await Promise.all([
      api.member.list({ limit: 25, offset: 0, sort: "points" }),
      api.member.metrics({ tiers: tierFloors }),
    ]);
    prefetched = true;
  } catch (error) {
    console.error("Roster prefetch failed:", error);
  }

  const body = (
    <>
      <PortalHeader
        eyebrow="Roster"
        title="Roster"
        body="Who has signed in, what they have earned, when they last came."
      />

      <RosterMetrics />

      <Section size="sm">
        <MembersTable />
      </Section>
    </>
  );

  return prefetched ? <HydrateClient>{body}</HydrateClient> : body;
}
