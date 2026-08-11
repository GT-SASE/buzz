import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { signInWithGoogle } from "~/app/portal/_components/auth-actions";
import { safeRedirectPath } from "~/app/portal/_lib/paths";
import { Eyebrow } from "~/components/site";
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
  const session = await auth();

  // Already signed in: honour where they were headed.
  if (session?.user) {
    redirect(from);
  }

  return (
    <section className="bg-cream paper-wash flex min-h-[70vh] items-center px-5 py-20 sm:px-6">
      <Card className="border-hairline bg-paper mx-auto w-full max-w-md rounded-lg">
        <CardHeader>
          <Eyebrow tone="gold">Member portal</Eyebrow>
          <h1 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight text-balance">
            Sign in to check in.
          </h1>
        </CardHeader>

        <CardContent>
          <p className="text-ink-muted text-body">
            Membership is free. Signing in is only how the chapter records that
            you were there and credits your points — there is nothing to pay and
            no application to fill out.
          </p>

          <form action={signInWithGoogle} className="mt-8">
            <input type="hidden" name="from" value={from} />
            <Button
              type="submit"
              size="lg"
              className="bg-navy hover:bg-navy-deep w-full rounded-none py-6 font-semibold text-white"
            >
              Continue with Google
            </Button>
          </form>

          <p className="text-ink-muted text-body-sm mt-6">
            Use your Georgia Tech account. Nothing is posted anywhere and the
            chapter only sees your name and email.
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
