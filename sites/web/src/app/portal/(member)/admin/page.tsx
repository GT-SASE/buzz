import type { Metadata } from "next";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { Attendance } from "./attendance";
import { AdminEvents } from "./admin-events";
import { Overview } from "./overview";

export const metadata: Metadata = { title: "Events" };

export default function AdminEventsPage() {
  return (
    <>
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
    </>
  );
}
