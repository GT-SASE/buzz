import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";

import { appRouter, createTRPCContext } from "@buzz/api";
import { env } from "~/env";

/**
 * Reject cross-site mutating requests. Queries (GET) are allowed so RSC and
 * prefetch keep working; mutations must be same-origin.
 */
function sameOriginRejection(req: NextRequest): Response | null {
  if (req.method === "GET" || req.method === "HEAD") return null;

  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return null;
  if (secFetchSite === "same-site") return null;

  const origin = req.headers.get("origin");
  if (!origin) {
    // Non-browser clients (tests, server callers) often omit Origin.
    if (!secFetchSite) return null;
    return new Response("Origin required", { status: 403 });
  }

  if (origin !== req.nextUrl.origin) {
    return new Response("Forbidden origin", { status: 403 });
  }

  return null;
}

const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = async (req: NextRequest) => {
  const rejected = sameOriginRejection(req);
  if (rejected) return rejected;

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError:
      env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(
              `tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
            );
          }
        : undefined,
  });
};

export { handler as GET, handler as POST };
