import type { MetadataRoute } from "next";

import { site } from "~/data/site";

/**
 * Installed to a home screen, this is the member portal rather than the
 * marketing site: `start_url` is `/portal` because the reason to install is
 * checking in at the door in one tap. `display: "standalone"` drops the
 * browser chrome, which is what makes the QR scanner feel like a camera app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.shortName,
    description: site.description,
    start_url: "/portal",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f1e5",
    theme_color: "#003057",
    icons: [
      { src: "/icon", sizes: "32x32", type: "image/png" },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
