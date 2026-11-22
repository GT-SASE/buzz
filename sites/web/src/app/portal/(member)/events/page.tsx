import type { Metadata } from "next";
import { Suspense } from "react";

import { eventPath, firstParam } from "~/app/portal/_lib/paths";
import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import PortalLoading from "../loading";
import { UpcomingEvents } from "./upcoming-events";

export const metadata: Metadata = { title: "Upcoming events" };

export default function EventsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string | string[] }>;
}) {
  return (
    <Suspense fallback={<PortalLoading />}>
      <EventsBody searchParams={searchParams} />
    </Suspense>
  );
}

async function EventsBody({
  searchParams,
}: {
  searchParams: Promise<{ event?: string | string[] }>;
}) {
  const { event } = await searchParams;
  const focusId = firstParam(event);
  await requireSession(focusId ? eventPath(focusId) : "/portal/events");
  await api.event.upcoming.prefetch();

  return (
    <HydrateClient>
      <UpcomingEvents focusId={focusId} />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
