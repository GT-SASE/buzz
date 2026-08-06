import { notFound } from "next/navigation";

import { requireOfficer } from "~/app/portal/_lib/session";
import { PresentScreen } from "./present-screen";

export default async function PresentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOfficer(`/portal/admin/events/${id}/present`);
  if (!id) notFound();

  return <PresentScreen eventId={id} />;
}
