import "server-only";

import { createHydrationHelpers } from "@trpc/react-query/rsc";
import { headers } from "next/headers";
import { cache } from "react";

import { createCaller, createTRPCContext, type AppRouter } from "@buzz/api";
import { createQueryClient } from "./query-client";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a tRPC call from a React Server Component.
 */
const createContext = cache(async () => {
  const heads = new Headers(await headers());
  heads.set("x-trpc-source", "rsc");

  return createTRPCContext({
    headers: heads,
  });
});

const getQueryClient = cache(createQueryClient);
const caller = createCaller(createContext);

export const { trpc: api, HydrateClient } = createHydrationHelpers<AppRouter>(
  caller,
  getQueryClient,
);

/**
 * `await api.x.y(input)` for a page that reads the result itself and also
 * renders a client `useQuery` on the same procedure, so one database call fills
 * both. It rejects on failure, which `orNotFound` relies on and `.prefetch()`
 * would swallow. The key must match what tRPC builds for the client hook.
 */
export function hydrated<T>(
  path: [router: string, procedure: string],
  input: unknown,
  load: () => Promise<T>,
) {
  return getQueryClient().fetchQuery({
    queryKey: [path, { input, type: "query" }],
    queryFn: load,
  });
}
