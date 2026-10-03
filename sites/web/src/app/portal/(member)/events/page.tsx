import type { Metadata } from "next";
import { Suspense } from "react";

import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { HydrateClient, api } from "~/trpc/server";
import PortalLoading from "../loading";
import { UpcomingEvents } from "./upcoming-events";

export const metadata: Metadata = { title: "Upcoming events" };

export default function EventsPage() {
  return (
    <Suspense fallback={<PortalLoading />}>
      <EventsBody />
    </Suspense>
  );
}

async function EventsBody() {
  await requireSession("/portal/events");
  await api.event.upcoming();

  return (
    <HydrateClient>
      <UpcomingEvents />
      <Toaster position="bottom-center" />
    </HydrateClient>
  );
}
