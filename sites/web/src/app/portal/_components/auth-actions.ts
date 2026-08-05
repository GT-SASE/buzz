"use server";

import { signIn, signOut } from "@buzz/auth";

/**
 * `redirectTo` is validated as a same-origin path before it is handed to
 * next-auth: `from` arrives in a query string, so without this check a crafted
 * link would bounce a member to another site immediately after they sign in.
 */
function safePath(value: FormDataEntryValue | null) {
  if (typeof value !== "string") return "/portal";
  if (!value.startsWith("/") || value.startsWith("//")) return "/portal";
  return value;
}

export async function signInWithGoogle(formData: FormData) {
  await signIn("google", { redirectTo: safePath(formData.get("from")) });
}

export async function signOutOfPortal() {
  await signOut({ redirectTo: "/" });
}
