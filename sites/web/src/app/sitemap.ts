import type { MetadataRoute } from "next";

import { getPublishedPageList } from "~/data/pages";
import { buildSitemap } from "~/lib/sitemap";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  return buildSitemap(await getPublishedPageList());
}
