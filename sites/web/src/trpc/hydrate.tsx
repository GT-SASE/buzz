import { TRPCReactProvider } from "./react";
import { HydrateQueries } from "./server";

/**
 * Hydrates the queries a page prefetched and mounts the tRPC/React Query client
 * for the client components under it. The provider lives here, not in a layout,
 * and apart from `server.ts` so a page with no client `api.*` hooks imports
 * neither this nor the client code.
 */
export function HydrateClient({ children }: { children: React.ReactNode }) {
  return (
    <TRPCReactProvider>
      <HydrateQueries>{children}</HydrateQueries>
    </TRPCReactProvider>
  );
}
