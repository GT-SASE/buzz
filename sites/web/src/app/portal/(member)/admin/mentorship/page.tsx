import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section, TextLink } from "~/components/site";
import { HydrateClient, api } from "~/trpc/server";
import { kinYear } from "@buzz/api";
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
  const currentYear = kinYear(new Date());
  await Promise.all([
    api.mentorship.list({ year: currentYear }),
    api.mentorship.groups({ year: currentYear }),
    api.mentorship.years(),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        eyebrow="SASE KIN"
        title="Kin groups"
        body="Groups and signups reset every school year. Set up groups, place people who signed up, and tap +5 after a meeting."
      />
      <Section size="sm">
        <KinAdmin currentYear={currentYear} />
        <p className="text-ink-muted text-body-sm mt-8">
          Officers who want a family of their own can{" "}
          <TextLink href="/portal/mentorship">sign up here</TextLink>.
        </p>
      </Section>
    </HydrateClient>
  );
}
