import { redirect } from "next/navigation";

import { auth } from "@buzz/auth";

/**
 * Gate a portal page, remembering where the visitor was headed.
 *
 * Deliberately per-page rather than in the layout: a layout cannot see the
 * request path, so a layout-level redirect would drop the `?code=` off a
 * check-in link and land the member on an empty form after signing in.
 *
 * This is a courtesy gate. The procedures in `@buzz/api` are
 * what actually protect the data.
 */
export async function requireSession(from: string) {
  const session = await auth();
  if (!session?.user) {
    redirect(`/portal/signin?from=${encodeURIComponent(from)}`);
  }
  return session;
}

/** As above, plus the officer check that mirrors `adminProcedure`. */
export async function requireOfficer(from: string) {
  const session = await requireSession(from);
  if (session.user.role !== "ADMIN") {
    redirect("/portal");
  }
  return session;
}
