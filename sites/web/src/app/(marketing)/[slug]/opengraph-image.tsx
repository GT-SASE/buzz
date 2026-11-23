import { notFound } from "next/navigation";

import { getPublishedPage } from "~/data/pages";
import { site } from "~/data/site";
import { clipCardText, renderShareCard } from "~/lib/share-card";

export const alt = site.name;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** The share card for a page an officer published: its own title and description. */
export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) notFound();

  return renderShareCard({
    label: "SASE GT",
    title: clipCardText(page.title, 70),
    subtitle: clipCardText(page.description || site.description, 120),
  });
}
