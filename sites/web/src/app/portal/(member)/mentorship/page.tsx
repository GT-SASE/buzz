import type { Metadata } from "next";
import { Suspense } from "react";

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
  await requireSession("/portal/mentorship");
  await api.mentorship.mine();

  return (
    <HydrateClient>
      <MentorshipSignup />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
