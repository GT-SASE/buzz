import type { Metadata } from "next";

import { firstParam } from "~/app/portal/_lib/paths";
import { Toaster } from "~/components/ui/sonner";
import { auth } from "@buzz/auth";
import { CheckInForm } from "./check-in-form";
import { SignInRedirect } from "./signin-redirect";

export const metadata: Metadata = {
  title: "Check in",
};

export default async function CheckInPage({
  searchParams,
}: {
  // QR links use `#code=`, read client-side. `?code=` is how that code survives
  // the sign-in round-trip (see SignInRedirect).
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const code = firstParam((await searchParams).code);

  // Signed out: hand off to sign-in from the browser, which can still read the
  // `#code=` a scanned QR carries and keep it through Google's round-trip.
  const session = await auth();
  if (!session?.user) {
    return (
      <div className="mx-auto w-full max-w-md px-5 py-6 sm:px-6 sm:py-14">
        <SignInRedirect />
      </div>
    );
  }

  // No masthead. This is a task done standing up in a room, usually one-handed.
  return (
    <div className="mx-auto w-full max-w-md px-5 py-6 sm:px-6 sm:py-14">
      <h1 className="sr-only">Check in</h1>
      <CheckInForm initialCode={code ?? ""} />
      <Toaster position="bottom-center" />
    </div>
  );
}
