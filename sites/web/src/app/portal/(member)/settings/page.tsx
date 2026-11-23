import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import PortalLoading from "../loading";
import { LeaderboardSettings } from "./leaderboard-settings";
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
  await Promise.all([
    api.notification.mine.prefetch(),
    api.member.leaderboardPreference.prefetch(),
  ]);

  return (
    <HydrateClient>
      <NotificationSettings />
      <LeaderboardSettings />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
