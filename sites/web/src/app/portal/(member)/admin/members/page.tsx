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
        eyebrow="Roster"
        title="Roster"
        body="Who has signed in, what they have earned, when they last came."
      />

      <Section size="sm">
        <MembersTable />
      </Section>
    </>
  );
}
