import type { Metadata } from "next";

import { firstParam } from "~/app/portal/_lib/paths";
import { requireSession } from "~/app/portal/_lib/session";
import { Toaster } from "~/components/ui/sonner";
import { CheckInForm } from "./check-in-form";

export const metadata: Metadata = {
  title: "Check in",
};

export default async function CheckInPage({
  searchParams,
}: {
  // Legacy `?code=` still accepted for signed-out OAuth round-trips. New QR
  // links use `#code=` and are read client-side.
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const code = firstParam((await searchParams).code);

  // Carried through sign-in so a member who scanned a poster while signed out
  // lands back here with the code intact (query only — fragments are stripped
  // by the OAuth redirect).
  await requireSession(
    code
      ? `/portal/check-in?code=${encodeURIComponent(code)}`
      : "/portal/check-in",
  );

  // No masthead. This is a task done standing up in a room, usually one-handed.
  return (
    <div className="mx-auto w-full max-w-md px-5 py-10 sm:px-6 sm:py-14">
      <CheckInForm initialCode={code ?? ""} />
      <Toaster position="top-center" />
    </div>
  );
}
