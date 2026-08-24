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

const EXPECTED_CODES = new Set([
  "BAD_REQUEST",
  "CONFLICT",
  "FORBIDDEN",
  "NOT_FOUND",
  "TOO_MANY_REQUESTS",
  "UNAUTHORIZED",
]);

function logTRPCError({
  path,
  error,
  ctx,
}: {
  path: string | undefined;
  error: { code: string; message: string; cause?: unknown; stack?: string };
  ctx:
    | { session?: { user?: { id?: string; role?: string } } | null }
    | undefined;
}) {
  const expected = EXPECTED_CODES.has(error.code);
  const cause = error.cause;

  const line = {
    level: expected ? "warn" : "error",
    event: "trpc.error",
    path: path ?? "<no-path>",
    code: error.code,
    message: error.message,
    userId: ctx?.session?.user?.id ?? null,
    role: ctx?.session?.user?.role ?? null,
    ...(expected
      ? {}
      : {
          stack:
            (cause instanceof Error ? cause.stack : undefined) ?? error.stack,
        }),
  };

  if (env.NODE_ENV === "development") {
    console[expected ? "warn" : "error"](
      `tRPC ${error.code} on ${line.path}: ${error.message}`,
      expected ? "" : (line.stack ?? ""),
    );
    return;
  }

  console[expected ? "warn" : "error"](JSON.stringify(line));
}

const handler = async (req: NextRequest) => {
  const rejected = sameOriginRejection(req);
  if (rejected) return rejected;

  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError: ({ path, error, ctx }) => {
      logTRPCError({ path, error, ctx });
    },
  });
};

export { handler as GET, handler as POST };
