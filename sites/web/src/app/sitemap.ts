import type { MetadataRoute } from "next";

import { getChapterEvents } from "~/data/chapter-events";
import { getPublishedPageList } from "~/data/pages";
import { buildSitemap } from "~/lib/sitemap";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [pages, { upcoming, past }] = await Promise.all([
    getPublishedPageList(),
    getChapterEvents(),
  ]);
  return buildSitemap(pages, [
    ...upcoming.map((event) => ({ ...event, upcoming: true })),
    ...past.map((event) => ({ ...event, upcoming: false })),
  ]);
}
