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
        eyebrow="Officer tools"
        title="Chapter events."
        body="Create an event, set what attending is worth, and read out the code at the door. Attendance and points are recorded the moment a member enters it."
      />

      <Overview />

      <Section size="sm">
        <AdminEvents />
      </Section>
    </>
  );
}
