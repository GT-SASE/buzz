import type { Metadata } from "next";

// Every portal page reads the session and the database per request. Declaring
// it here keeps the eight marketing routes prerendered — nothing outside this
// subtree touches `auth()` or `db`.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Member portal",
  // robots.txt only asks crawlers not to fetch these; this is what asks them
  // not to index one they reached some other way. Both are needed.
  robots: { index: false, follow: false },
};

export default function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
