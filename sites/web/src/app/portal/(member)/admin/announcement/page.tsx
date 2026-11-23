import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import AdminLoading from "../loading";
import { AnnouncementForm } from "./announcement-form";

export const metadata: Metadata = { title: "Banner" };

export default function AdminAnnouncementPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminAnnouncementBody />
    </Suspense>
  );
}

async function AdminAnnouncementBody() {
  await api.announcement.get.prefetch();

  return (
    <HydrateClient>
      <PortalHeader
        title="Site banner"
        body="One notice across the top of every public page. Visitors can dismiss it; saving a change shows it to everyone again."
      />
      <Section size="sm">
        <AnnouncementForm />
      </Section>
    </HydrateClient>
  );
}
