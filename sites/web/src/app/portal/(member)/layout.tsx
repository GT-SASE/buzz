import { PortalSidebar } from "~/app/portal/_components/portal-sidebar";
import { SignOutButton } from "~/app/portal/_components/portal-ui";
import { SignedOutHeader } from "~/app/portal/_components/signed-out-header";
import { PortalProviders } from "~/app/portal/providers";
import { auth } from "@buzz/auth";
import { isOfficerRole } from "@buzz/db";

// Every member page reads the session and the database per request. Declaring
// it here keeps the marketing routes and /portal/signin prerendered.
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * This layout does not redirect. A layout cannot see the request path, so
 * redirecting from here would drop the `?code=` off a check-in link; each page
 * calls `requireSession` with its own path instead.
 */
export default async function MemberPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = (await auth())?.user;

  return (
    <>
      {!user && <SignedOutHeader />}

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
          <PortalProviders>{children}</PortalProviders>
        </main>
      </div>
    </>
  );
}
