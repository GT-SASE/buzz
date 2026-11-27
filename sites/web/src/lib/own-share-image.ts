import type { Metadata } from "next";

/**
 * `pageMetadata` with its share image tags dropped, for a route that has its
 * own `opengraph-image` file. A page that names `openGraph.images` itself wins
 * over the file next to it (measured on Next 16.4.6: `about.html` kept the
 * chapter-wide card), so the page has to leave the tags out for the file's
 * image, with its content hash in the URL, to reach the document.
 * tests/web/share-images.test.ts holds every route with a file to this.
 */
export function withOwnShareImage(metadata: Metadata): Metadata {
  const openGraph = metadata.openGraph && { ...metadata.openGraph };
  if (openGraph) delete openGraph.images;
  const twitter = metadata.twitter && { ...metadata.twitter };
  if (twitter) delete twitter.images;
  return {
    ...metadata,
    ...(openGraph ? { openGraph } : {}),
    ...(twitter ? { twitter } : {}),
  };
}
