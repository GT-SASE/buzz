import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section, TextLink } from "~/components/site";
import { committeeCycle } from "~/data/committees";
import { HydrateClient, api } from "~/trpc/server";
import AdminLoading from "../loading";
import { CommitteeInbox } from "./committee-inbox";

export const metadata: Metadata = { title: "Committees" };

export default function AdminCommitteesPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminCommitteesBody />
    </Suspense>
  );
}

async function AdminCommitteesBody() {
  await api.committee.list();

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="Committees"
        title={`${committeeCycle.label} applications`}
        body="Read the answers, run the callback from the prompts on each application, and mark who moves forward. Notes stay on the row — members never see them."
      />
      <Section size="sm">
        <CommitteeInbox />
        <p className="text-ink-muted text-body-sm mt-8">
          Applicants use{" "}
          <TextLink href="/portal/committees">this form</TextLink>. Closes{" "}
          {committeeCycle.closesLabel}.
        </p>
      </Section>
    </HydrateClient>
  );
}
