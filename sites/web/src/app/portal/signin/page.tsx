import type { Metadata } from "next";
import { Suspense } from "react";

import { SignedOutHeader } from "~/app/portal/_components/signed-out-header";
import { afterSignIn } from "~/app/portal/_lib/paths";
import { Eyebrow, SaseDino } from "~/components/site";
import { site } from "~/data/site";
import { SignInCard, SignInView } from "./sign-in-card";

export const metadata: Metadata = {
  title: "Sign in",
};

/**
 * Prerendered and served from the CDN, so the page every "Join SASE" button
 * lands on never waits on a cold function. `from` and the signed-in redirect
 * are handled in the browser by `SignInCard`.
 */
export default function SignInPage() {
  // Static markup for the card, rendered here so its client file stays small.
  const dino = <SaseDino className="mb-5 h-20" />;
  const eyebrow = <Eyebrow tone="gold">{site.portalName}</Eyebrow>;

  return (
    <>
      <SignedOutHeader />
      <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
        <main
          id="content"
          tabIndex={-1}
          className="min-w-0 flex-1 focus:shadow-none focus:outline-none"
        >
          <section className="bg-cream relative flex min-h-[calc(100dvh-4.5rem)] items-center overflow-hidden px-5 py-10 sm:px-6 sm:py-20">
            <Suspense
              fallback={
                <SignInView from={afterSignIn} dino={dino} eyebrow={eyebrow} />
              }
            >
              <SignInCard dino={dino} eyebrow={eyebrow} />
            </Suspense>
          </section>
        </main>
      </div>
    </>
  );
}
