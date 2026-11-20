import type { Metadata } from "next";
import { Suspense } from "react";

import { PortalHeader } from "~/app/portal/_components/portal-ui";
import { Section } from "~/components/site";
import { HydrateClient } from "~/trpc/hydrate";
import { api } from "~/trpc/server";
import AdminLoading from "../loading";
import { PageList } from "./page-list";

export const metadata: Metadata = { title: "Pages" };

export default function AdminPagesPage() {
  return (
    <Suspense fallback={<AdminLoading />}>
      <AdminPagesBody />
    </Suspense>
  );
}

async function AdminPagesBody() {
  await api.page.list.prefetch();

  return (
    <HydrateClient>
      <PortalHeader
        title="Pages"
        body="Write a page in Markdown and publish it on the public site at its own URL. Drafts stay hidden until you publish."
      />
      <Section size="sm">
        <PageList />
      </Section>
    </HydrateClient>
  );
}
