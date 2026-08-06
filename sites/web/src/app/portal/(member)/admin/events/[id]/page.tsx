import Link from "next/link";

import { Section } from "~/components/site";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { EventAttendance } from "./event-attendance";

export default async function AdminEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  return (
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
  );
}
