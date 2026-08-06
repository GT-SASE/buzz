import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { AdminEvents } from "./admin-events";

export default function AdminEventsPage() {
  return (
    <>
      <PortalHeader
        eyebrow="Officer tools"
        title="Chapter events."
        body="Create an event, set what attending is worth, and read out the code at the door. Attendance and points are recorded the moment a member enters it."
      />

      <Section size="sm">
        <AdminEvents />
      </Section>
    </>
  );
}
