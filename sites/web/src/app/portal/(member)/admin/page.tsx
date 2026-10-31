import type { Metadata } from "next";

import Link from "next/link";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { Button } from "~/components/ui/button";
import { HydrateClient, api } from "~/trpc/server";
import { Attendance } from "./attendance";
import { AdminEvents } from "./admin-events";
import AdminLoading from "./loading";
import { Overview } from "./overview";

export const metadata: Metadata = { title: "Events" };

export default function AdminEventsPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminEventsBody />
    </Suspense>
  );
}

async function AdminEventsBody() {
  await Promise.all([
    api.chapter.overview.prefetch(),
    api.chapter.attendance.prefetch({ period: "semester" }),
    api.chapter.turnout.prefetch({ period: "semester" }),
    api.event.listAll.prefetch({ limit: 200, offset: 0 }),
  ]);

  return (
    <HydrateClient>
      <PortalHeader
        title="Events"
        body="Open check-in and put the QR on a screen. Officers scan it too."
        aside={
          <Button asChild variant="outline" className="min-h-11">
            <Link href="/portal/check-in">Scan to check in</Link>
          </Button>
        }
      />

      <div className="flex flex-col">
        <Overview />

        <Attendance />

        {/* On a phone the events are the job; the figures can wait. */}
        <Section size="sm" className="order-first md:order-none">
          <AdminEvents />
        </Section>
      </div>
    </HydrateClient>
  );
}
