import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section, TextLink } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import AdminLoading from "../loading";
import { CommitteeAdmin } from "./committee-admin";
import { defaultCycle } from "./default-cycle";

export const metadata: Metadata = { title: "Committees" };

export default function AdminCommitteesPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminCommitteesBody />
    </Suspense>
  );
}

async function AdminCommitteesBody() {
  const cycles = await api.committee.cycles();
  await api.committee.list({ cycle: defaultCycle(cycles) });

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="Committees"
        title="Committee applications"
        body="Open this semester's recruiting, read the answers, run the callback from the prompts on each application, and mark who moves forward. Notes stay on the row — members never see them."
      />
      <Section size="sm">
        <CommitteeAdmin />
        <p className="text-ink-muted text-body-sm mt-8">
          Applicants use{" "}
          <TextLink href="/portal/committees">this form</TextLink>. While a
          cycle is open, /join and the member dashboard advertise it on their
          own.
        </p>
      </Section>
    </HydrateClient>
  );
}
