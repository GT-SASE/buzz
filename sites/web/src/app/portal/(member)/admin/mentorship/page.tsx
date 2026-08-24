import type { Metadata } from "next";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { MentorshipRoster } from "./mentorship-roster";

export const metadata: Metadata = { title: "Mentor families" };

export default function AdminMentorshipPage() {
  return (
    <>
      <PortalHeader
        eyebrow="Families"
        title="Mentor families"
        body="Enroll people who signed up. Family points are separate from event check-ins — tap +5 after a meeting."
      />
      <Section size="sm">
        <MentorshipRoster />
      </Section>
    </>
  );
}
