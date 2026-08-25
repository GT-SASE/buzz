import type { Metadata } from "next";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section, TextLink } from "~/components/site";
import { MentorshipRoster } from "./mentorship-roster";

export const metadata: Metadata = { title: "SASE KIN" };

export default function AdminMentorshipPage() {
  return (
    <>
      <PortalHeader
        eyebrow="SASE KIN"
        title="Kin groups"
        body="Enroll people who signed up. KIN points are separate from event check-ins — tap +5 after a meeting."
      />
      <Section size="sm">
        <MentorshipRoster />
        <p className="text-ink-muted text-body-sm mt-8">
          Officers who want a family of their own can{" "}
          <TextLink href="/portal/mentorship">sign up here</TextLink>.
        </p>
      </Section>
    </>
  );
}
