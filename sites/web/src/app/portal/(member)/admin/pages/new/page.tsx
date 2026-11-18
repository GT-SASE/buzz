import type { Metadata } from "next";

import { requireOfficer } from "~/app/portal/_lib/session";
import { Section } from "~/components/site";
import { PageBreadcrumb } from "../page-breadcrumb";
import { PageEditor } from "../page-editor";

export const metadata: Metadata = { title: "New page" };

export default async function NewPagePage() {
  await requireOfficer("/portal/admin/pages/new");

  return (
    <Section size="sm">
      <PageBreadcrumb current="New page" />
      <PageEditor />
    </Section>
  );
}
