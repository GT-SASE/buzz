import { notFound } from "next/navigation";

/**
 * A missing event or member should be the portal 404, not a thrown RSC error
 * that Next renders as the marketing error page.
 *
 * Duck-typed on `code` rather than `instanceof TRPCError`: the caller and the
 * router may each resolve `@trpc/server` from a different package copy under
 * pnpm, and then `instanceof` lies.
 */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "NOT_FOUND"
    ) {
      notFound();
    }
    throw error;
  }
}
