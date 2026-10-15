import type { Metadata } from "next";
import Link from "next/link";

import { PortalSidebar } from "~/app/portal/_components/portal-sidebar";
import { SignOutButton } from "~/app/portal/_components/portal-ui";
import { Wordmark } from "~/components/site";
import { auth } from "@buzz/auth";
import { isOfficerRole } from "@buzz/db";

// Every portal page reads the session and the database per request. Declaring
// it here keeps the marketing routes prerendered.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: { default: "Member portal", template: "%s · GT SASE" },
  // robots.txt only asks crawlers not to fetch these; this asks them not to
  // index one they reached some other way. Both are needed.
  robots: { index: false, follow: false },
};

export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = (await auth())?.user;

  return (
    <>
      <a
        href="#content"
        className="focus:bg-navy sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-60 focus:px-5 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>
      {/* Signed-out visitors (sign-in, check-in) get a bare header, no menu. */}
      {!user && (
        <header className="border-gold bg-paper sticky top-0 z-40 border-b-2 pt-[env(safe-area-inset-top)]">
          <div className="max-w-content mx-auto flex items-center justify-between gap-4 px-5 py-3 sm:gap-6 sm:px-6 sm:py-4">
            <Link
              href="/"
              className="inline-flex min-h-11 shrink-0 items-center"
            >
              <Wordmark tone="dark" />
            </Link>
          </div>
        </header>
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        {user && (
          <PortalSidebar
            isOfficer={isOfficerRole(user.role)}
            name={user.name ?? null}
            email={user.email ?? null}
            signOut={<SignOutButton />}
          />
        )}
        <main
          id="content"
          tabIndex={-1}
          className="min-w-0 flex-1 focus:shadow-none focus:outline-none"
        >
          {children}
        </main>
      </div>
    </>
  );
}
