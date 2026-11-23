import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import PortalLoading from "../loading";
import { NotificationSettings } from "./notification-settings";

export const metadata: Metadata = {
  title: "Settings",
};

export default function SettingsPage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <SettingsBody />
    </Suspense>
  );
}

async function SettingsBody() {
  await requireSession("/portal/settings");
  await api.notification.mine.prefetch();

  return (
    <HydrateClient>
      <NotificationSettings />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
