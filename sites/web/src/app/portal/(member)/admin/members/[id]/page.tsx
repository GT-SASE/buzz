import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

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
import { MemberDetail } from "./member-detail";

export const metadata: Metadata = {
  title: "Member",
};

export default async function AdminMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!id) notFound();
  await orNotFound(api.member.byId({ id }));

  return (
    <HydrateClient>
      <Section size="sm">
        <Breadcrumb className="mb-8">
          <BreadcrumbList className="text-ink-muted text-body-sm">
            <BreadcrumbItem>
              <BreadcrumbLink asChild className="hover:text-navy font-semibold">
                <Link href="/portal/admin/members">All members</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="text-navy font-semibold">
                Member
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <MemberDetail memberId={id} />
      </Section>
    </HydrateClient>
  );
}
