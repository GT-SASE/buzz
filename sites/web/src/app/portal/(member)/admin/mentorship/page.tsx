import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section, TextLink } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import { semester } from "@buzz/api";
import AdminLoading from "../loading";
import { KinAdmin } from "./kin-admin";

export const metadata: Metadata = { title: "SASE KIN" };

export default function AdminMentorshipPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminMentorshipBody />
    </Suspense>
  );
}

async function AdminMentorshipBody() {
  const currentSemester = semester(new Date());
  await Promise.all([
    api.mentorship.list({ semester: currentSemester }),
    api.mentorship.groups({ semester: currentSemester }),
    api.mentorship.semesters(),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="SASE KIN"
        title="Kin groups"
        body="Groups change every semester; signups and KIN points last the school year. Set up groups, place people who signed up, and tap +5 after a meeting."
      />
      <Section size="sm">
        <KinAdmin currentSemester={currentSemester} />
        <p className="text-ink-muted text-body-sm mt-8">
          Officers who want a family of their own can{" "}
          <TextLink href="/portal/mentorship">sign up here</TextLink>.
        </p>
      </Section>
    </HydrateClient>
  );
}
