import { notFound } from "next/navigation";

import { orNotFound } from "~/app/portal/_lib/missing";
import { requireOfficer } from "~/app/portal/_lib/session";
import { HydrateClient, api } from "~/trpc/server";
import { PresentScreen } from "./present-screen";

export default async function PresentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOfficer(`/portal/admin/events/${id}/present`);
  if (!id) notFound();
  await orNotFound(api.event.getById({ id }));

  return (
    <HydrateClient>
      <PresentScreen eventId={id} />
    </HydrateClient>
  );
}
