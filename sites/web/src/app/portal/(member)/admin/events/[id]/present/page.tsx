import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { orNotFound } from "~/app/portal/_lib/missing";
import { requireOfficer } from "~/app/portal/_lib/session";
import { HydrateClient, api } from "~/trpc/server";
import { PresentScreen } from "./present-screen";

const eventForPage = cache((id: string) => api.event.getById({ id }));

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  try {
    const { event } = await eventForPage(id);
    return { title: `Projector · ${event.title}` };
  } catch {
    return { title: "Projector" };
  }
}

export default async function PresentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOfficer(`/portal/admin/events/${id}/present`);
  if (!id) notFound();
  await orNotFound(eventForPage(id));

  return (
    <HydrateClient>
      <PresentScreen eventId={id} />
    </HydrateClient>
  );
}
