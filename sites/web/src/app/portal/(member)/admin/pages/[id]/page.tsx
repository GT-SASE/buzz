import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { orNotFound } from "~/app/portal/_lib/missing";
import { requireOfficer } from "~/app/portal/_lib/session";
import { Section } from "~/components/site";
import { HydrateClient } from "~/trpc/hydrate";
import { api, hydrated } from "~/trpc/server";
import { PageBreadcrumb } from "../page-breadcrumb";
import { PageEditor } from "../page-editor";

const pageForEditor = cache((id: string) =>
  hydrated(["page", "byId"], { id }, () => api.page.byId({ id })),
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  if (!id) return { title: "Page" };

  try {
    const page = await pageForEditor(id);
    return { title: page.title };
  } catch {
    return { title: "Page" };
  }
}

export default async function EditPagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!id) notFound();
  await requireOfficer(`/portal/admin/pages/${id}`);
  const page = await orNotFound(pageForEditor(id));

  return (
    <HydrateClient>
      <Section size="sm">
        <PageBreadcrumb current={page.title} />
        <PageEditor pageId={id} />
      </Section>
    </HydrateClient>
  );
}
