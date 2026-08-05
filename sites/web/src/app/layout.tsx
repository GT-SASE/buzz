import "~/styles/globals.css";

import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";

import { SiteFooter } from "~/app/_components/site-footer";
import { SiteNav } from "~/app/_components/site-nav";
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

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // No client providers here on purpose: every page is a static server
    // component, so wrapping the tree in the tRPC/React Query provider shipped
    // ~500 kB of client JS that nothing on the site ever called.
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <body className="text-ink bg-paper flex min-h-screen flex-col antialiased">
        {/* One organization record for the whole site; interior pages add their
            own breadcrumb, event, and FAQ graphs on top of it. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={jsonLd(organizationSchema())}
        />
        {/* The id is SiteNav's handle on this link: it marks the link inert
            alongside <main> and <footer> while the mobile panel is open, so
            skipping to content the overlay covers cannot strand focus. */}
        <a
          id="skip-to-content"
          href="#content"
          className="focus:bg-navy sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:px-5 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
        >
          Skip to content
        </a>
        <SiteNav />
        {/* tabIndex makes the skip link actually move focus in Safari. The
            global :focus-visible ring is two properties, so both have to go
            or the whole page picks up a gold halo on skip. */}
        <main
          id="content"
          tabIndex={-1}
          className="flex-1 focus:shadow-none focus:outline-none"
        >
          {children}
        </main>
        <SiteFooter />
      </body>
    </html>
  );
}
