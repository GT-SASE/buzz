import { PortalTabs } from "~/app/portal/_components/portal-tabs";
import { PortalProviders } from "~/app/portal/providers";
import { auth } from "~/server/auth";

/**
 * Chrome for the signed-in portal.
 *
 * This layout does not redirect. A layout cannot see the request path, so
 * redirecting from here would drop the `?code=` off a check-in link; each page
 * calls `requireSession` with its own path instead. A visitor with no session
 * renders nothing here because the page below redirects during the same pass.
 */
export default async function MemberPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) return children;

  return (
    <PortalProviders>
      <PortalTabs isOfficer={session.user.role === "ADMIN"} />
      {children}
    </PortalProviders>
  );
}
