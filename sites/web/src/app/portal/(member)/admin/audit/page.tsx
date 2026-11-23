import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import AdminLoading from "../loading";
import { PAGE_SIZE } from "./audit-text";
import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "Audit" };

export default function AdminAuditPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminAuditBody />
    </Suspense>
  );
}

async function AdminAuditBody() {
  await Promise.all([
    api.audit.log.prefetch({ limit: PAGE_SIZE, offset: 0 }),
    api.audit.actors.prefetch(),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        title="Audit"
        body="What officers changed, and every point that moved. Entries are written with the change itself and cannot be edited here."
      />
      <Section size="sm">
        <AuditView />
      </Section>
    </HydrateClient>
  );
}
