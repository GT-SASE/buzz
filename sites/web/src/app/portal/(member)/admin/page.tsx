import type { Metadata } from "next";

import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import { Attendance } from "./attendance";
import { AdminEvents } from "./admin-events";
import AdminLoading from "./loading";
import { Overview } from "./overview";

export const metadata: Metadata = { title: "Events" };

export default function AdminEventsPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminEventsBody />
    </Suspense>
  );
}

async function AdminEventsBody() {
  await Promise.all([
    api.chapter.overview(),
    api.chapter.attendance({ period: "semester" }),
    api.event.listAll({ limit: 200, offset: 0 }),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="Events"
        title="Events"
        body="Open check-in and put the QR on a screen. No scanning."
      />

      <Overview />

      <Attendance />

      <Section size="sm">
        <AdminEvents />
      </Section>
    </HydrateClient>
  );
}
