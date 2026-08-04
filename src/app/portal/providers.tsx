"use client";

import { TRPCReactProvider } from "~/trpc/react";

/**
 * The tRPC/React Query client, mounted here and nowhere else.
 *
 * The root layout deliberately ships no client providers so the eight
 * marketing routes stay static and pay nothing for a client the portal is the
 * only thing that calls. Keep it that way: this boundary is why /join is still
 * a prerendered page with no React Query in its bundle.
 *
 * No SessionProvider either — every portal page reads `auth()` on the server
 * and passes what it needs down as props, which skips next-auth's client
 * bundle and its /api/auth/session round trip on first paint.
 */
export function PortalProviders({ children }: { children: React.ReactNode }) {
  return <TRPCReactProvider>{children}</TRPCReactProvider>;
}
