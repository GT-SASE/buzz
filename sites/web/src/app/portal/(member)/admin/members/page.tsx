import type { Metadata } from "next";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { MembersTable } from "./members-table";

export const metadata: Metadata = {
  title: "Roster",
};

export default function AdminMembersPage() {
  return (
    <>
      <PortalHeader
        eyebrow="Officer tools"
        title="Chapter roster."
        body="Everyone who has signed in to the portal, what they have earned, and when they were last at an event. Open a member for their full attendance history."
      />

      <Section size="sm">
        <MembersTable />
      </Section>
    </>
  );
}
