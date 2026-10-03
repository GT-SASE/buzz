import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { signInWithGoogle } from "~/app/portal/_components/auth-actions";
import { safeRedirectPath } from "~/app/portal/_lib/paths";
import { Eyebrow, Honeycomb } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { auth } from "@buzz/auth";

export const metadata: Metadata = {
  title: "Sign in",
};

export default async function SignInPage({
  searchParams,
}: {
  // Next really does hand back an array when a key repeats.
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { from: rawFrom } = await searchParams;
  const from = safeRedirectPath(rawFrom);
  const checkingIn = from.startsWith("/portal/check-in");
  const session = await auth();

  // Already signed in: honour where they were headed.
  if (session?.user) {
    redirect(from);
  }

  return (
    <section className="bg-cream paper-wash relative flex min-h-[70vh] items-center overflow-hidden px-5 py-20 sm:px-6">
      <Honeycomb className="text-gold/20 pointer-events-none absolute inset-0 h-full w-full" />
      <Card className="border-hairline bg-paper relative mx-auto w-full max-w-md rounded-xl">
        <CardHeader>
          <Eyebrow tone="gold">Buzz by SASE</Eyebrow>
          <h1 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight text-balance">
            {checkingIn ? "Sign in to check in." : "Become a member."}
          </h1>
        </CardHeader>

        <CardContent>
          <p className="text-ink-muted text-body">
            {checkingIn
              ? "Signing in is how the chapter records that you were there and credits your points. You will land back on the check-in screen."
              : "Membership is free. Sign in with Google and you are a member — your card, points, and SASE KIN signup all live in the portal. There is nothing to pay and no application to fill out."}
          </p>

          <form action={signInWithGoogle} className="mt-8">
            <input type="hidden" name="from" value={from} />
            <Button
              type="submit"
              size="lg"
              className="bg-navy hover:bg-navy-deep h-auto min-h-12 w-full rounded-md py-6 font-semibold text-white"
            >
              Continue with Google
            </Button>
          </form>

          <p className="text-ink-muted text-body-sm mt-6">
            Sign in with any Google account. Nothing is posted anywhere and the
            chapter only sees your name and email.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
