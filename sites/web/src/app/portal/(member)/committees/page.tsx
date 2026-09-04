import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient, api } from "~/trpc/server";
import PortalLoading from "../loading";
import { CommitteeApplyForm } from "./committee-apply-form";

export const metadata: Metadata = {
  title: "Committees",
};

export default function CommitteeApplyPage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <CommitteeApplyBody />
    </Suspense>
  );
}

async function CommitteeApplyBody() {
  await requireSession("/portal/committees");
  await api.committee.mine();

  return (
    <HydrateClient>
      <CommitteeApplyForm />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
