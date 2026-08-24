import type { Metadata } from "next";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { AdminEvents } from "./admin-events";
import { Overview } from "./overview";

export const metadata: Metadata = { title: "Events" };

export default function AdminEventsPage() {
  return (
    <>
      <PortalHeader
        eyebrow="Events"
        title="Events"
        body="Open check-in, put the QR on a screen, and check yourself in from the event. No scanning."
      />

      <Overview />

      <Section size="sm">
        <AdminEvents />
      </Section>
    </>
  );
}
