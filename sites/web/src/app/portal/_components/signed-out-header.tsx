import Link from "next/link";

import { Wordmark } from "~/components/site";

/** Signed-out visitors (sign-in, check-in) get a bare header, no menu. */
export function SignedOutHeader() {
  return (
    <header className="border-gold bg-paper sticky top-0 z-40 border-b-2 pt-[env(safe-area-inset-top)]">
      <div className="max-w-content mx-auto flex items-center justify-between gap-4 px-5 py-3 sm:gap-6 sm:px-6 sm:py-4">
        <Link href="/" className="inline-flex min-h-11 shrink-0 items-center">
          <Wordmark tone="dark" />
        </Link>
      </div>
    </header>
  );
}
