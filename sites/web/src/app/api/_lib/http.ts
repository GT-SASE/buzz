import type { NextRequest } from "next/server";

export const jsonError = (error: string, status: number) =>
  Response.json({ error }, { status });

/** Rejects cross-site writes. Call it from mutating handlers only. */
export function sameOriginRejection(req: NextRequest): Response | null {
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite === "same-origin" || secFetchSite === "none") return null;

  const origin = req.headers.get("origin");
  if (!origin) {
    if (!secFetchSite) return null;
    return jsonError("Origin required", 403);
  }
  if (origin !== req.nextUrl.origin) {
    return jsonError("Forbidden origin", 403);
  }
  return null;
}
