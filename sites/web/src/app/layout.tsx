import "~/styles/globals.css";
import "~/styles/fonts.generated.css";

import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { preload } from "react-dom";

import { fontPreloads } from "~/data/fonts.generated";
import { site } from "~/data/site";
import { env } from "~/env";
import {
  googleSiteVerification,
  jsonLd,
  organizationSchema,
  shareImage,
} from "~/lib/seo";

const defaultTitle = `${site.name} — ${site.tagline}`;
const defaultDescription = site.description;
const googleVerification = googleSiteVerification(
  env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
);

export const metadata: Metadata = {
  // Makes every relative canonical/OG URL in a page's metadata absolute.
  metadataBase: new URL(site.url),
  title: {
    default: defaultTitle,
    // Portal pages pass a short title and pick up this suffix. Public pages
    // set an absolute title in `pageMetadata` instead.
    template: `%s · GT SASE`,
  },
  description: defaultDescription,
  applicationName: "GT SASE",
  keywords: [
    "GT SASE",
    "SASE at Georgia Tech",
    "SASE",
    "SASE Georgia Tech",
    "Society of Asian Scientists and Engineers",
    "Georgia Tech student organization",
    "Asian STEM organization",
    "Georgia Tech clubs",
    "Atlanta STEM community",
    "engineering student org",
  ],
  authors: [{ name: site.name, url: site.url }],
  creator: site.name,
  publisher: site.name,
  category: "education",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    title: defaultTitle,
    description: defaultDescription,
    url: site.url,
    siteName: site.name,
    locale: "en_US",
    type: "website",
    images: [shareImage],
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: defaultDescription,
    images: [shareImage.url],
  },
  ...(googleVerification ? { verification: googleVerification } : {}),
};

export const viewport: Viewport = {
  themeColor: "#003057",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  maximumScale: 5,
  userScalable: true,
};

/**
 * Document shell only. Chrome lives in the route groups — (marketing) mounts
 * the public nav and footer, the portal mounts its own — so a signed-in member
 * no longer gets the marketing footer stapled under their check-in screen.
 *
 * No client providers here: every marketing page is a static server component,
 * and mounting the tRPC/React Query client globally shipped ~500 kB of client
 * JS that nothing on the public site ever called.
 */
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // Font files are subset by hand: see scripts/fonts/README.md. A new weight,
  // width, OpenType feature or character range may need a rerun.
  for (const href of fontPreloads) {
    preload(href, { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  }

  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className="text-ink bg-paper flex min-h-screen flex-col antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={jsonLd(organizationSchema())}
        />
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
