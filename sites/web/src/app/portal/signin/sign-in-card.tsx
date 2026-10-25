"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { signInWithGoogle } from "~/app/portal/_components/auth-actions";
import { checkInPath, safeRedirectPath } from "~/app/portal/_lib/paths";
import { Eyebrow, SaseDino } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { site } from "~/data/site";

/**
 * Reads `from` in the browser and sends an already signed-in visitor on to
 * it. Doing both here instead of on the server is what lets the page be
 * prerendered; without a session cookie /api/auth/session never touches the
 * database.
 */
export function SignInCard() {
  const router = useRouter();
  const from = safeRedirectPath(useSearchParams().getAll("from"));

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session")
      .then((response) => (response.ok ? response.json() : null))
      .then((session: { user?: unknown } | null) => {
        if (!cancelled && session?.user) router.replace(from);
      })
      .catch(() => {
        // Stay on the sign-in card; signing in again still works.
      });
    return () => {
      cancelled = true;
    };
  }, [from, router]);

  return <SignInView from={from} />;
}

export function SignInView({ from }: { from: string }) {
  const checkingIn = from.startsWith(checkInPath());

  return (
    <Card className="border-hairline bg-paper relative mx-auto w-full max-w-md rounded-xl">
      <CardHeader>
        <SaseDino className="mb-5 h-20" />
        <Eyebrow tone="gold">{site.portalName}</Eyebrow>
        <h1 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight text-balance">
          {checkingIn ? "Sign in to check in." : "Become a member."}
        </h1>
      </CardHeader>

      <CardContent>
        <p className="text-ink-muted text-body">
          {checkingIn
            ? "Signing in is how the chapter records that you were there and credits your points. You will land back on the check-in screen."
            : "Membership is free. Sign in with Google and you are a member. Your card, points, and SASE KIN signup all live in the portal. There is nothing to pay and no application to fill out."}
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
  );
}
