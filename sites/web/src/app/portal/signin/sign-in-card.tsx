"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

import { signInWithGoogle } from "~/app/portal/_components/auth-actions";
import {
  afterSignIn,
  checkInPath,
  safeRedirectPath,
} from "~/app/portal/_lib/paths";

/**
 * The mascot and the portal-name eyebrow are static, so the page renders them
 * on the server and passes them in. Every public page prefetches this route
 * (the Join buttons point here), and this file is its client JS: importing
 * `Button`, `Card` or the site barrel here put tailwind-merge, Slot and lucide
 * (~59 kB decoded) into every public page's prefetch. tests/web/public-bundle.test.ts
 * keeps them out.
 */
type Slots = { dino: React.ReactNode; eyebrow: React.ReactNode };

/**
 * Reads `from` in the browser and sends an already signed-in visitor on to
 * it. Doing both here instead of on the server is what lets the page be
 * prerendered; without a session cookie /api/auth/session never touches the
 * database.
 */
export function SignInCard({ dino, eyebrow }: Slots) {
  const router = useRouter();
  const requested = useSearchParams().getAll("from");
  const from = requested.length ? safeRedirectPath(requested) : afterSignIn;

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

  return <SignInView from={from} dino={dino} eyebrow={eyebrow} />;
}

export function SignInView({ from, dino, eyebrow }: { from: string } & Slots) {
  const checkingIn = from.startsWith(checkInPath());

  return (
    <div className="border-hairline bg-paper text-card-foreground relative mx-auto flex w-full max-w-md flex-col gap-6 rounded-xl border py-6 shadow-sm">
      <div className="grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6">
        {dino}
        {eyebrow}
        <h1 className="font-display text-navy text-h2 mt-5 font-bold tracking-tight text-balance">
          {checkingIn ? "Sign in to check in." : "Become a member."}
        </h1>
      </div>

      <div className="px-6">
        <p className="text-ink-muted text-body">
          {checkingIn
            ? "Signing in is how the chapter records that you were there and credits your points. You will land back on the check-in screen."
            : "Membership is free. Sign in with Google and you are a member. Your card, points, and SASE KIN signup all live in the portal. There is nothing to pay and no application to fill out."}
        </p>

        <form action={signInWithGoogle} className="mt-8">
          <input type="hidden" name="from" value={from} />
          <button
            type="submit"
            className="bg-navy hover:bg-navy-deep focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-auto min-h-12 w-full shrink-0 items-center justify-center gap-2 rounded-md px-6 py-6 text-sm font-semibold whitespace-nowrap text-white transition-all outline-none focus-visible:ring-[3px]"
          >
            Continue with Google
          </button>
        </form>

        <p className="text-ink-muted text-body-sm mt-6">
          Sign in with any Google account. Nothing is posted anywhere and the
          chapter only sees your name and email.
        </p>
      </div>
    </div>
  );
}
