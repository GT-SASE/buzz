import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "Member portal", template: "%s · GT SASE" },
  // robots.txt only asks crawlers not to fetch these; this asks them not to
  // index one they reached some other way. Both are needed.
  robots: { index: false, follow: false },
};

/**
 * No session read here, so /portal/signin can be prerendered and served from
 * the CDN. The session-dependent chrome lives in `(member)/layout.tsx`.
 */
export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <a
        href="#content"
        className="focus:bg-navy sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:px-5 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      {children}
    </>
  );
}
