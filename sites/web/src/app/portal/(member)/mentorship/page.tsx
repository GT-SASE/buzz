import type { Metadata } from "next";
import { Suspense } from "react";

import { semester, semesterLabel } from "@buzz/api";
import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient, api } from "~/trpc/server";
import PortalLoading from "../loading";
import { MentorshipSignup } from "./mentorship-signup";

export const metadata: Metadata = {
  title: "SASE KIN",
};

export default function MentorshipPage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <MentorshipBody />
    </Suspense>
  );
}

async function MentorshipBody() {
  const session = await requireSession("/portal/mentorship");
  await Promise.all([
    api.mentorship.mine(),
    api.mentorship.groups(),
    api.mentorship.myGroup(),
  ]);

  return (
    <HydrateClient>
      <MentorshipSignup
        name={session.user.name ?? session.user.email ?? "Member"}
        term={semesterLabel(semester(new Date()))}
      />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
