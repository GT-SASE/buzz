import { PortalProviders } from "~/app/portal/providers";

/**
 * This layout does not redirect. A layout cannot see the request path, so
 * redirecting from here would drop the `?code=` off a check-in link; each page
 * calls `requireSession` with its own path instead.
 */
export default function MemberPortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <PortalProviders>{children}</PortalProviders>;
}
