import { auth } from "@buzz/auth";
import type { Metadata } from "next";
import Link from "next/link";
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
import { HydrateClient } from "~/trpc/hydrate";
import { api, hydrated } from "~/trpc/server";
import { MemberDetail } from "./member-detail";

const memberForPage = cache((id: string) =>
  hydrated(["member", "byId"], { id }, () => api.member.byId({ id })),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;

  try {
    const { member } = await memberForPage(id);
    return { title: member.name ?? member.email };
  } catch {
    return { title: "Member" };
  }
}

export default async function AdminMemberPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [{ member }, session] = await Promise.all([
    orNotFound(memberForPage(id)),
    auth(),
  ]);

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
              <BreadcrumbPage className="text-navy max-w-[16rem] truncate font-semibold">
                {member.name ?? member.email}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <MemberDetail
          memberId={id}
          canManageRoles={session?.user.role === "SUPER_ADMIN"}
        />
      </Section>
    </HydrateClient>
  );
}
