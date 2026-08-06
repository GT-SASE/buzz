"use client";

import { TRPCReactProvider } from "~/trpc/react";

/**
 * The tRPC/React Query client, mounted here and nowhere else, so the marketing
 * routes stay static. No SessionProvider either — every portal page reads
 * `auth()` on the server and passes what it needs down as props.
 */
export function PortalProviders({ children }: { children: React.ReactNode }) {
  return <TRPCReactProvider>{children}</TRPCReactProvider>;
}
