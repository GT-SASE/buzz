import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient, api } from "~/trpc/server";
import PortalLoading from "../loading";
import { ElectionsView } from "./elections-view";

export const metadata: Metadata = { title: "Elections" };

export default function ElectionsPage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <ElectionsBody />
    </Suspense>
  );
}

async function ElectionsBody() {
  await requireSession("/portal/elections");
  await api.election.current();

  return (
    <HydrateClient>
      <ElectionsView />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
