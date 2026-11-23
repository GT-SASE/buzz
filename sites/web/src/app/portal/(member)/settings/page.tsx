import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import PortalLoading from "../loading";
import { HeadshotSettings } from "./headshot-settings";
import { LeaderboardSettings } from "./leaderboard-settings";
import { ProfileSettings } from "./profile-settings";
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
  const session = await requireSession("/portal/settings");
  await Promise.all([
    api.notification.mine.prefetch(),
    api.member.leaderboardPreference.prefetch(),
    api.member.profile.prefetch(),
    api.headshot.mine.prefetch(),
  ]);

  return (
    <HydrateClient>
      <header className="mx-auto w-full max-w-lg px-5 pt-10 pb-8 sm:px-6 sm:pt-14">
        <p className="text-eyebrow tracking-caps text-gold-ink font-semibold uppercase">
          Settings
        </p>
        <h1 className="font-display text-navy text-h2 mt-3 font-bold tracking-tight">
          Your account.
        </h1>
        <p className="text-ink-muted text-body mt-4">
          Email, your details and how you show up on the leaderboard. Each
          section saves on its own.
        </p>
      </header>
      <NotificationSettings />
      <ProfileSettings />
      <LeaderboardSettings />
      <HeadshotSettings
        name={session.user.name ?? session.user.email ?? "Member"}
      />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
