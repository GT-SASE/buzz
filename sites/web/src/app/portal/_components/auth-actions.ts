"use server";

import { signIn, signOut } from "@buzz/auth";
import { safeRedirectPath } from "~/app/portal/_lib/paths";

/**
 * `redirectTo` is validated as a same-origin path before it is handed to
 * next-auth: `from` arrives in a query string, so without this check a crafted
 * link would bounce a member to another site immediately after they sign in.
 */
function safePath(value: FormDataEntryValue | null) {
  return safeRedirectPath(typeof value === "string" ? value : undefined);
}

export async function signInWithGoogle(formData: FormData) {
  await signIn("google", { redirectTo: safePath(formData.get("from")) });
}

export async function signOutOfPortal() {
  await signOut({ redirectTo: "/" });
}
