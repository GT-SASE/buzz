/**
 * Postgres unique_violation. Drizzle wraps every driver error, and the pg error
 * carrying the SQLSTATE sits on `.cause`, so the chain has to be walked —
 * checking only the top-level object silently never matches in production.
 *
 * The depth bound is not decoration: a cause chain can be circular, and an
 * unbounded walk hangs the request thread rather than failing.
 */
export function isUniqueViolation(error: unknown) {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    if (typeof cursor !== "object") break;
    if ((cursor as { code?: string }).code === "23505") return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}
