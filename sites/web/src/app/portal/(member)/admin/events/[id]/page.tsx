import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { orNotFound } from "~/app/portal/_lib/missing";
import { Section } from "~/components/site";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { HydrateClient, api } from "~/trpc/server";
import { EventAttendance } from "./event-attendance";

const eventForPage = cache((id: string) => api.event.getById({ id }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!id) return { title: "Event" };

  try {
    const { event } = await eventForPage(id);
    return { title: event.title };
  } catch {
    return { title: "Event" };
  }
}

export default async function AdminEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!id) notFound();
  await orNotFound(eventForPage(id));

  return (
    <HydrateClient>
      <Section size="sm">
        <Breadcrumb className="mb-8">
          <BreadcrumbList className="text-ink-muted text-body-sm">
            <BreadcrumbItem>
              <BreadcrumbLink asChild className="hover:text-navy font-semibold">
                <Link href="/portal/admin">All events</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="text-navy font-semibold">
                Attendance
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <EventAttendance eventId={id} />
      </Section>
    </HydrateClient>
  );
}
