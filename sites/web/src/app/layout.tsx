import "~/styles/globals.css";

import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Bricolage_Grotesque, Fraunces, IBM_Plex_Mono } from "next/font/google";

import { site } from "~/data/site";
import { jsonLd, organizationSchema } from "~/lib/seo";

export const metadata: Metadata = {
  // Makes every relative canonical/OG URL in a page's metadata absolute.
  metadataBase: new URL(site.url),
  title: {
    default: `${site.name} — ${site.tagline}`,
    template: `%s · ${site.shortName}`,
  },
  description: site.description,
  applicationName: site.name,
  keywords: [
    site.theme,
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
  icons: [{ rel: "icon", url: "/favicon.ico" }],
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
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
    url: site.url,
    siteName: site.name,
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${site.name} — ${site.tagline}`,
    description: site.description,
  },
};

export const viewport: Viewport = {
  themeColor: "#003057",
};

const sans = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

// Bold only: every `font-display` element on the site is also `font-bold`, and
// the full variable face costs several times this for weights nothing renders.
const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["700"],
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm",
  weight: ["500"],
  display: "swap",
});

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
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${sans.variable} ${display.variable} ${mono.variable}`}
    >
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
